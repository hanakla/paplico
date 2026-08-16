import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	Document,
	FillAppearance,
	Group,
	Path,
	PathSegment,
	RawRGBA,
	Viewport,
} from "../../schema";
import { loadPapfDocument } from "../../testUtils/loadTestDocument";
import { createTestRenderer } from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";

/**
 * Render-performance baseline probe (no assertions on timings).
 *
 * Quantifies, on the current renderer, the costs that the Inkscape-style
 * optimizations (store/oversized cache, dirty regions, bake-cache tuning,
 * blur pyramid) are expected to remove. Timings are wall-clock including a
 * `queue.onSubmittedWorkDone()` wait, so they cover GPU completion.
 * Absolute values differ from the browser build (happy-dom polyfills skip
 * image decode); compare cases within one run only.
 */

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 800;
const BACKGROUND: RawRGBA = { r: 1, g: 1, b: 1, a: 1 };
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };
const WARMUP_FRAMES = 3;
const MEASURE_FRAMES = 12;
const PAN_STEP_PX = 16;
const TESTS_DIR = resolve(__dirname, "../../../tests");

const results: BenchRecord[] = [];

describe("render perf baseline", () => {
	afterAll(() => {
		if (results.length === 0) return;
		const outDir = resolve(__dirname, "../../../../perf-results");
		mkdirSync(outDir, { recursive: true });
		const outPath = resolve(
			outDir,
			`render-perf-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
		);
		writeFileSync(outPath, JSON.stringify(results, null, 2));
		console.log(`[perf] results written to ${outPath}`);
	});

	for (const docFile of ["test-document.papf", "living-day-nights-perf.papf"]) {
		it(`measures static / pan / invalidate-all frames on ${docFile}`, async (ctx) => {
			// Perf documents other than test-document.papf are not checked in;
			// skip instead of failing test:visual on machines that lack them.
			if (!existsSync(resolve(TESTS_DIR, docFile))) return ctx.skip();
			const doc = await loadPapfDocument(resolve(TESTS_DIR, docFile));
			logRss(docFile);
			console.log(
				`[perf] ${docFile}: ${Object.keys(doc.objects).length} objects, ${doc.layers.length} layers, viewport zoom=${doc.viewport.zoom}`,
			);
			const { renderer } = await createTestRenderer();
			const base: Viewport = { ...doc.viewport, rotation: 0 };

			for (let i = 0; i < WARMUP_FRAMES; i++) {
				await renderFrame(renderer, doc, base, UNCHANGED);
			}

			const staticSplit = await measureSplit(MEASURE_FRAMES, () =>
				renderFrame(renderer, doc, base, UNCHANGED),
			);
			reportSplit(docFile, "static", staticSplit);

			const panSplit = await measureSplit(MEASURE_FRAMES, (i) =>
				renderFrame(
					renderer,
					doc,
					{ ...base, x: base.x + (i + 1) * PAN_STEP_PX },
					UNCHANGED,
				),
			);
			reportSplit(docFile, "pan", panSplit);

			const allIds: ChangedElements = {
				upserted: new Set(Object.keys(doc.objects)),
				deleted: new Set(),
			};
			const invalidateSplit = await measureSplit(MEASURE_FRAMES, (i) =>
				renderFrame(
					renderer,
					doc,
					{ ...base, x: base.x + (i + 1) * PAN_STEP_PX },
					allIds,
				),
			);
			reportSplit(docFile, "invalidate-all-pan", invalidateSplit);

			expect(panSplit.total.length).toBe(MEASURE_FRAMES);
		}, 600_000);
	}

	it("measures the blit floor (full-canvas texture copy)", async () => {
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");

		const makeTexture = (usage: number) =>
			device.createTexture({
				size: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
				format: "rgba8unorm",
				usage,
			});
		const src = makeTexture(
			GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
		);
		const dst = makeTexture(
			GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
		);

		const blitMs = await measure(MEASURE_FRAMES, async () => {
			const encoder = device.createCommandEncoder();
			encoder.copyTextureToTexture(
				{ texture: src },
				{ texture: dst },
				{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
			);
			device.queue.submit([encoder.finish()]);
			await device.queue.onSubmittedWorkDone();
		});
		report("synthetic", "blit-floor", blitMs);

		src.destroy();
		dst.destroy();
		expect(blitMs.length).toBe(MEASURE_FRAMES);
	}, 120_000);

	it("measures blur cost scaling over radius (direct kernel check)", async () => {
		const { renderer } = await createTestRenderer();
		const forceRerun: ChangedElements = {
			upserted: new Set([BLURRED_ID]),
			deleted: new Set(),
		};
		const base: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

		for (const radius of [8, 32, 128]) {
			const doc = createBlurDocument(radius);
			for (let i = 0; i < WARMUP_FRAMES; i++) {
				await renderFrame(renderer, doc, base, forceRerun);
			}
			const ms = await measure(MEASURE_FRAMES, () =>
				renderFrame(renderer, doc, base, forceRerun),
			);
			report("synthetic", `blur-radius-${radius}`, ms);
		}
		expect(true).toBe(true);
	}, 300_000);

	it("measures pan blit on the interactive frame path (living doc)", async (ctx) => {
		const docPath = resolve(TESTS_DIR, "living-day-nights-perf.papf");
		if (!existsSync(docPath)) return ctx.skip();
		const doc = await loadPapfDocument(docPath);
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");
		const blitPasses = trackViewportBlitPasses(device);

		const base: Viewport = { ...doc.viewport, rotation: 0 };
		const renderInteractive = async (
			viewport: Viewport,
			strategy: "full" | "viewportBlit",
		) => {
			renderer.render({ viewport, document: doc, strategy }, {});
			await device.queue.onSubmittedWorkDone();
		};

		for (let i = 0; i < WARMUP_FRAMES; i++) {
			await renderInteractive(base, "full");
		}

		// Pan ~16 device px per frame; 12 frames stay inside the 256px store
		// margin, so after the first fall-through (which bakes the margin) every
		// frame must hit the blit path.
		const stepWorld = 16 / base.zoom;
		blitPasses.count = 0;
		const panBlitMs = await measure(MEASURE_FRAMES, (i) =>
			renderInteractive(
				{ ...base, x: base.x + (i + 1) * stepWorld },
				"viewportBlit",
			),
		);
		report("living-day-nights-perf.papf", "pan-blit-interactive", panBlitMs);
		console.log(
			`[perf] viewport blit passes: ${blitPasses.count}/${MEASURE_FRAMES}`,
		);

		expect(blitPasses.count).toBeGreaterThan(0);
	}, 600_000);

	it("measures a single-element edit frame on the interactive path (living doc)", async (ctx) => {
		const docPath = resolve(TESTS_DIR, "living-day-nights-perf.papf");
		if (!existsSync(docPath)) return ctx.skip();
		const doc = await loadPapfDocument(docPath);
		// Smallest path in the document: the dirty rect of a partial redraw is
		// the element's bounds, so the target's size decides the measurement.
		const target = findSmallestPath(doc);
		if (!target) {
			console.log("[perf] no path element found, skipping edit-single");
			return;
		}
		logFilterProcessorInventory(doc);
		console.log(
			`[perf] edit target ${target.id} filters=${JSON.stringify(
				(target.filters ?? []).map((f) => f.processor),
			)}`,
		);
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");
		const partialPasses = trackPassLabelCount(
			device,
			"Canvas Layer Prebuf Pass (partial)",
		);

		const base: Viewport = { ...doc.viewport, rotation: 0 };
		let current = doc;
		const renderEdit = async (frame: number): Promise<number> => {
			// Immutable single-element update: visually near-no-op opacity nudge,
			// but a real tracked content change (plan cache miss, push
			// invalidation) — the shape of every brush-stroke commit frame.
			const edited = {
				...target,
				opacity: frame % 2 === 0 ? 0.999 : 1,
			};
			current = {
				...current,
				objects: { ...current.objects, [target.id]: edited },
			};
			const start = performance.now();
			renderer.render(
				{
					viewport: base,
					document: current,
					strategy: "full",
					changedElements: {
						upserted: new Set([target.id]),
						deleted: new Set(),
					},
				},
				{},
			);
			const cpuMs = performance.now() - start;
			await device.queue.onSubmittedWorkDone();
			return cpuMs;
		};

		for (let i = 0; i < WARMUP_FRAMES; i++) {
			await renderEdit(i);
		}
		partialPasses.count = 0;
		const editSplit = await measureSplit(MEASURE_FRAMES, (i) =>
			renderEdit(i + WARMUP_FRAMES),
		);
		reportSplit(
			"living-day-nights-perf.papf",
			"edit-single-interactive",
			editSplit,
		);
		console.log(
			`[perf] partial prebuf passes: ${partialPasses.count} across ${MEASURE_FRAMES} frames`,
		);

		expect(editSplit.total.length).toBe(MEASURE_FRAMES);
	}, 600_000);

	it("measures subtree-move cost on living-day-nights-perf.papf", async (ctx) => {
		const docPath = resolve(TESTS_DIR, "living-day-nights-perf.papf");
		if (!existsSync(docPath)) return ctx.skip();
		const doc = await loadPapfDocument(docPath);
		const group = findLargestGroup(doc);
		if (!group) {
			console.log("[perf] no group found in document, skipping subtree-move");
			return;
		}
		console.log(
			`[perf] moving group ${group.id} (${group.childIds.length} direct children)`,
		);

		const { renderer } = await createTestRenderer();
		const base: Viewport = { ...doc.viewport, rotation: 0 };

		for (let i = 0; i < WARMUP_FRAMES; i++) {
			await renderFrame(renderer, doc, base, UNCHANGED);
		}
		const staticMs = await measure(MEASURE_FRAMES, () =>
			renderFrame(renderer, doc, base, UNCHANGED),
		);
		report("living-day-nights-perf.papf", "static-for-move", staticMs);

		const moveChange: ChangedElements = {
			upserted: new Set([group.id]),
			deleted: new Set(),
		};
		const moveMs = await measure(MEASURE_FRAMES, (i) => {
			const moved = moveGroup(doc, group, (i + 1) * 4);
			return renderFrame(renderer, moved, base, moveChange);
		});
		report("living-day-nights-perf.papf", "group-move", moveMs);

		expect(moveMs.length).toBe(MEASURE_FRAMES);
	}, 600_000);
});

// Helpers

interface BenchRecord {
	doc: string;
	case: string;
	n: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
	avgMs: number;
}

/** Renders one frame and returns the CPU-side time (encode + submit). The GPU
 *  tail is whatever remains until onSubmittedWorkDone resolves. */
async function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	viewport: Viewport,
	changedElements: ChangedElements,
): Promise<number> {
	const start = performance.now();
	// disableViewportCulling=false: keep the editor path (viewport culling and
	// the interactive bake clamp). Leaving it undefined defaults to true (the
	// export path) and renders the whole document world every frame.
	const texture = await renderer.renderViewportToTexture(
		viewport,
		doc,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
		BACKGROUND,
		changedElements,
		undefined,
		false,
		false,
	);
	const cpuMs = performance.now() - start;
	if (!texture) throw new Error("render returned no texture");
	const device = renderer.getDevice();
	if (device) await device.queue.onSubmittedWorkDone();
	texture.destroy();
	return cpuMs;
}

interface SplitSamples {
	total: number[];
	cpu: number[];
}

async function measureSplit(
	frames: number,
	fn: (index: number) => Promise<number>,
): Promise<SplitSamples> {
	const total: number[] = [];
	const cpu: number[] = [];
	for (let i = 0; i < frames; i++) {
		const start = performance.now();
		cpu.push(await fn(i));
		total.push(performance.now() - start);
	}
	return { total, cpu };
}

function reportSplit(doc: string, caseName: string, split: SplitSamples): void {
	report(doc, caseName, split.total);
	report(doc, `${caseName}-cpu`, split.cpu);
}

async function measure(
	frames: number,
	fn: (index: number) => Promise<unknown>,
): Promise<number[]> {
	const samples: number[] = [];
	for (let i = 0; i < frames; i++) {
		const start = performance.now();
		await fn(i);
		samples.push(performance.now() - start);
	}
	return samples;
}

function report(doc: string, caseName: string, samples: number[]): void {
	const sorted = [...samples].sort((a, b) => a - b);
	const pct = (q: number) =>
		+sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(
			2,
		);
	const record: BenchRecord = {
		doc,
		case: caseName,
		n: samples.length,
		p50Ms: pct(0.5),
		p95Ms: pct(0.95),
		maxMs: +sorted[sorted.length - 1].toFixed(2),
		avgMs: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2),
	};
	results.push(record);
	console.log(
		`[perf] ${doc} / ${caseName}: p50=${record.p50Ms}ms p95=${record.p95Ms}ms max=${record.maxMs}ms avg=${record.avgMs}ms n=${record.n}`,
	);
}

/** Counts "Viewport Blit Pass" render passes — the activation proof that a
 *  frame took the composite-blit path instead of re-rendering the document. */
function trackViewportBlitPasses(device: GPUDevice): { count: number } {
	return trackPassLabelCount(device, "Viewport Blit Pass");
}

/** Counts render passes with an exact label — activation proof for a path. */
function trackPassLabelCount(
	device: GPUDevice,
	label: string,
): { count: number } {
	const counter = { count: 0 };
	const originalCreate = device.createCommandEncoder.bind(device);
	device.createCommandEncoder = ((descriptor?: GPUCommandEncoderDescriptor) => {
		const encoder = originalCreate(descriptor);
		const originalBegin = encoder.beginRenderPass.bind(encoder);
		encoder.beginRenderPass = ((desc: GPURenderPassDescriptor) => {
			if (desc.label === label) counter.count++;
			return originalBegin(desc);
		}) as typeof encoder.beginRenderPass;
		return encoder;
	}) as typeof device.createCommandEncoder;
	return counter;
}

/** Smallest-extent path element (by its segment endpoints; local-space proxy
 *  for the world dirty rect a partial redraw of it produces). */
function findSmallestPath(doc: Document): Path | null {
	let best: Path | null = null;
	let bestArea = Infinity;
	for (const element of Object.values(doc.objects)) {
		if (element?.type !== "path" || element.segments.length === 0) continue;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const seg of element.segments) {
			for (const p of [seg.start, seg.end]) {
				if (!p) continue;
				minX = Math.min(minX, p.x);
				minY = Math.min(minY, p.y);
				maxX = Math.max(maxX, p.x);
				maxY = Math.max(maxY, p.y);
			}
		}
		const area = (maxX - minX) * (maxY - minY);
		if (Number.isFinite(area) && area > 0 && area < bestArea) {
			bestArea = area;
			best = element;
		}
	}
	if (best) {
		console.log(
			`[perf] smallest path local extent area=${bestArea.toFixed(0)}`,
		);
	}
	return best;
}

/** Which filter processors the document uses, and how often (fallback-reason
 *  triage for the partial-redraw path). */
function logFilterProcessorInventory(doc: Document): void {
	const counts = new Map<string, number>();
	for (const element of Object.values(doc.objects)) {
		for (const filter of element?.filters ?? []) {
			counts.set(filter.processor, (counts.get(filter.processor) ?? 0) + 1);
		}
	}
	const summary = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name, n]) => `${name}:${n}`)
		.join(" ");
	console.log(`[perf] filter processors: ${summary}`);
}

function logRss(label: string): void {
	const rss = process.memoryUsage().rss / 1024 / 1024;
	console.log(`[perf] ${label} loaded, rss=${rss.toFixed(0)}MB`);
}

function findLargestGroup(doc: Document): Group | null {
	let best: Group | null = null;
	for (const element of Object.values(doc.objects)) {
		if (element.type !== "group") continue;
		if (!best || element.childIds.length > best.childIds.length) {
			best = element;
		}
	}
	return best;
}

function moveGroup(doc: Document, group: Group, offsetX: number): Document {
	const transform = group.transform ?? createDefaultTransform();
	const moved: Group = {
		...group,
		transform: { ...transform, x: transform.x + offsetX },
	};
	return { ...doc, objects: { ...doc.objects, [group.id]: moved } };
}

const BLURRED_ID = "perf-blurred-1";

/** One blurred red square, sized so the blur pass dominates the frame. */
function createBlurDocument(radius: number): Document {
	const document = createDefaultDocument("render-perf-baseline-blur");
	const layer = createDefaultLayer("layer-1", "Layer");
	const blurred: Path = {
		id: BLURRED_ID,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(-150, 150, -150, 150),
		filters: [
			fill({ r: 0.8, g: 0.1, b: 0.1, a: 1 }),
			{
				uid: "blur-1",
				processor: "blur",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: { radius } },
			},
		],
	};
	document.objects[blurred.id] = blurred;
	layer.elementIds.push(blurred.id);
	document.layers = [layer];
	return document;
}

function fill(color: RawRGBA): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...color } },
			},
		},
	};
}

function rectSegments(
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): PathSegment[] {
	const points = [
		{ x: minX, y: maxY },
		{ x: maxX, y: maxY },
		{ x: maxX, y: minY },
		{ x: minX, y: minY },
	];
	return points.map((point, index) => ({
		start: index === 0 ? point : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: points[(index + 1) % points.length],
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: index === 0,
		isClosed: index === points.length - 1,
	}));
}
