import { describe, expect, it } from "vitest";
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
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";
import type { CanvasTarget } from "../CanvasTarget";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const STATIC_ID = "static-rect";
const EDITED_ID = "edited-rect";
const CLIP_ID = "clip-rect";
const CLIP_GROUP_ID = "clip-group";
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };
const BASE_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

/**
 * A partial redraw (dirty-rect re-render + restore of the rest from the
 * composite cache) must be invisible in the output: the frame has to equal a
 * from-scratch full render of the same document. Runs on the interactive
 * frame path (RenderOrchestrator.render), the only path where partial
 * redraws engage.
 */
describe("partial redraw idempotency", () => {
	it("should render a tracked single-element edit identical to a full render, via the partial path", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");
		const partialPasses = trackPartialPasses(device);

		for (let i = 0; i < 3; i++) {
			renderFrame(renderer, createDocument(0), UNCHANGED);
			await device.queue.onSubmittedWorkDone();
		}

		// Move the edited rect: its old region must be restored to background
		// and its new region drawn — both inside the dirty rect.
		partialPasses.count = 0;
		renderFrame(renderer, createDocument(120), {
			upserted: new Set([EDITED_ID]),
			deleted: new Set(),
		});
		await device.queue.onSubmittedWorkDone();
		const partialPixels = await capturePresented(renderer, canvas);
		expect(partialPasses.count).toBeGreaterThan(0);

		const fresh = await createTestRenderer();
		const freshDevice = fresh.renderer.getDevice();
		if (!freshDevice) throw new Error("no GPU device");
		renderFrame(fresh.renderer, createDocument(120), UNCHANGED);
		await freshDevice.queue.onSubmittedWorkDone();
		const referencePixels = await capturePresented(
			fresh.renderer,
			fresh.canvas,
		);

		const differing = countDifferingPixels(partialPixels, referencePixels);
		if (differing > 0) logDiffBBox(partialPixels, referencePixels);
		expect(differing).toBe(0);
	}, 240_000);

	it("should render a tracked element deletion identical to a full render, via the partial path", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");
		const partialPasses = trackPartialPasses(device);

		for (let i = 0; i < 3; i++) {
			renderFrame(renderer, createDocument(0), UNCHANGED);
			await device.queue.onSubmittedWorkDone();
		}

		// Remove the rect: its pixels must return to background. The document no
		// longer knows the element, so the dirty rect comes purely from the
		// last-drawn bounds.
		partialPasses.count = 0;
		renderFrame(renderer, removeElement(createDocument(0), EDITED_ID), {
			upserted: new Set(),
			deleted: new Set([EDITED_ID]),
		});
		await device.queue.onSubmittedWorkDone();
		const partialPixels = await capturePresented(renderer, canvas);
		expect(partialPasses.count).toBeGreaterThan(0);

		const fresh = await createTestRenderer();
		const freshDevice = fresh.renderer.getDevice();
		if (!freshDevice) throw new Error("no GPU device");
		renderFrame(
			fresh.renderer,
			removeElement(createDocument(0), EDITED_ID),
			UNCHANGED,
		);
		await freshDevice.queue.onSubmittedWorkDone();
		const referencePixels = await capturePresented(
			fresh.renderer,
			fresh.canvas,
		);

		const differing = countDifferingPixels(partialPixels, referencePixels);
		if (differing > 0) logDiffBBox(partialPixels, referencePixels);
		expect(differing).toBe(0);
	}, 240_000);

	it("should render a tracked clip-path edit identical to a full render", async () => {
		// A clip-path edit changes the OWNER group's pixels, which the changed
		// element's own bounds cannot cover — the partial path must fall back,
		// and the targeted mask invalidation must drop the stale mask texture.
		const { renderer, canvas } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");

		for (let i = 0; i < 3; i++) {
			renderFrame(renderer, createClipDocument(120), UNCHANGED);
			await device.queue.onSubmittedWorkDone();
		}
		// Shrink the clip rect in place: content between the old and new clip
		// edges must disappear.
		renderFrame(renderer, createClipDocument(40), {
			upserted: new Set([CLIP_ID]),
			deleted: new Set(),
		});
		await device.queue.onSubmittedWorkDone();
		const editedPixels = await capturePresented(renderer, canvas);

		const fresh = await createTestRenderer();
		const freshDevice = fresh.renderer.getDevice();
		if (!freshDevice) throw new Error("no GPU device");
		renderFrame(fresh.renderer, createClipDocument(40), UNCHANGED);
		await freshDevice.queue.onSubmittedWorkDone();
		const referencePixels = await capturePresented(
			fresh.renderer,
			fresh.canvas,
		);

		const differing = countDifferingPixels(editedPixels, referencePixels);
		if (differing > 0) logDiffBBox(editedPixels, referencePixels);
		expect(differing).toBe(0);
	}, 240_000);

	it("should render a pan-blit frame identical to a full render at the panned viewport", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");
		const blitPasses = trackPassLabel(device, "Viewport Blit Pass");

		for (let i = 0; i < 3; i++) {
			renderFrame(renderer, createDocument(0), UNCHANGED);
			await device.queue.onSubmittedWorkDone();
		}
		// First pan falls through (content frames bake only the viewport) and
		// re-centers the store; the second pan must blit from it.
		renderPan(renderer, createDocument(0), 100);
		await device.queue.onSubmittedWorkDone();
		blitPasses.count = 0;
		renderPan(renderer, createDocument(0), 140);
		await device.queue.onSubmittedWorkDone();
		const blitPixels = await capturePresented(renderer, canvas);
		expect(blitPasses.count).toBeGreaterThan(0);

		const fresh = await createTestRenderer();
		const freshDevice = fresh.renderer.getDevice();
		if (!freshDevice) throw new Error("no GPU device");
		fresh.renderer.render(
			{
				viewport: { ...BASE_VIEWPORT, x: 140 },
				document: createDocument(0),
				strategy: "full",
				changedElements: UNCHANGED,
			},
			{},
		);
		await freshDevice.queue.onSubmittedWorkDone();
		const referencePixels = await capturePresented(
			fresh.renderer,
			fresh.canvas,
		);

		const differing = countDifferingPixels(blitPixels, referencePixels);
		if (differing > 0) logDiffBBox(blitPixels, referencePixels);
		expect(differing).toBe(0);
	}, 240_000);
});

// Helpers

function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	changedElements: ChangedElements,
): void {
	renderer.render(
		{
			viewport: BASE_VIEWPORT,
			document: doc,
			strategy: "full",
			changedElements,
		},
		{},
	);
}

function renderPan(
	renderer: RenderOrchestrator,
	doc: Document,
	x: number,
): void {
	renderer.render(
		{
			viewport: { ...BASE_VIEWPORT, x },
			document: doc,
			strategy: "viewportBlit",
			changedElements: UNCHANGED,
		},
		{},
	);
}

/** Read back the simulated swapchain texture the frame presented to. */
async function capturePresented(
	renderer: RenderOrchestrator,
	canvas: CanvasTarget,
): Promise<Uint8Array> {
	const device = renderer.getDevice();
	if (!device) throw new Error("no GPU device");
	const texture = (
		canvas as unknown as { _context: GPUCanvasContext }
	)._context.getCurrentTexture();
	return captureTexturePixels(device, texture, CANVAS_WIDTH, CANVAS_HEIGHT);
}

/** Counts prebuf passes rendered under a partial-redraw scissor. */
function trackPartialPasses(device: GPUDevice): { count: number } {
	return trackPassLabel(device, "Canvas Layer Prebuf Pass (partial)");
}

/** Counts render passes with an exact label — activation proof for a path. */
function trackPassLabel(device: GPUDevice, label: string): { count: number } {
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

/** Debug aid: where do the two frames disagree (canvas px, y down)? */
function logDiffBBox(a: Uint8Array, b: Uint8Array): void {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let y = 0; y < CANVAS_HEIGHT; y++) {
		for (let x = 0; x < CANVAS_WIDTH; x++) {
			const i = (y * CANVAS_WIDTH + x) * 4;
			if (
				Math.abs(a[i] - b[i]) > 1 ||
				Math.abs(a[i + 1] - b[i + 1]) > 1 ||
				Math.abs(a[i + 2] - b[i + 2]) > 1 ||
				Math.abs(a[i + 3] - b[i + 3]) > 1
			) {
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}
	console.log(
		`[partial-debug] diff bbox: x=${minX}..${maxX} y=${minY}..${maxY}`,
	);
}

function countDifferingPixels(a: Uint8Array, b: Uint8Array): number {
	let differing = 0;
	for (let i = 0; i < a.length; i += 4) {
		if (
			Math.abs(a[i] - b[i]) > 1 ||
			Math.abs(a[i + 1] - b[i + 1]) > 1 ||
			Math.abs(a[i + 2] - b[i + 2]) > 1 ||
			Math.abs(a[i + 3] - b[i + 3]) > 1
		) {
			differing++;
		}
	}
	return differing;
}

/** Immutable removal of one element from the document. */
function removeElement(doc: Document, id: string): Document {
	const objects = { ...doc.objects };
	delete objects[id];
	return {
		...doc,
		objects,
		layers: doc.layers.map((layer) => ({
			...layer,
			elementIds: layer.elementIds.filter((elementId) => elementId !== id),
		})),
	};
}

/** A clip group: a red rect clipped by a rect whose half-extent is
 *  `clipHalfExtent` — editing the extent reshapes the clip in place. */
function createClipDocument(clipHalfExtent: number): Document {
	const document = createDefaultDocument("partial-redraw-clip");
	const layer = createDefaultLayer("layer-1", "Layer");
	const content: Path = {
		id: EDITED_ID,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(-160, 160, -160, 160),
		filters: [fill({ r: 0.8, g: 0.1, b: 0.1, a: 1 })],
	};
	const clipPath: Path = {
		id: CLIP_ID,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(
			-clipHalfExtent,
			clipHalfExtent,
			-clipHalfExtent,
			clipHalfExtent,
		),
		filters: [fill({ r: 0, g: 0, b: 0, a: 1 })],
	};
	const group: Group = {
		id: CLIP_GROUP_ID,
		type: "group",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		childIds: [content.id],
		clipPathId: clipPath.id,
	};
	document.objects[content.id] = content;
	document.objects[clipPath.id] = clipPath;
	document.objects[group.id] = group;
	layer.elementIds.push(group.id);
	document.layers = [layer];
	return document;
}

/** Two plain rects; `editedOffsetX` moves one of them. */
function createDocument(editedOffsetX: number): Document {
	const document = createDefaultDocument("partial-redraw-idempotency");
	const layer = createDefaultLayer("layer-1", "Layer");
	const staticRect: Path = {
		id: STATIC_ID,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(-260, -140, -60, 60),
		filters: [fill({ r: 0.1, g: 0.3, b: 0.8, a: 1 })],
	};
	const editedRect: Path = {
		id: EDITED_ID,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: { ...createDefaultTransform(), x: editedOffsetX },
		segments: rectSegments(-60, 60, -60, 60),
		filters: [fill({ r: 0.8, g: 0.1, b: 0.1, a: 1 })],
	};
	document.objects[staticRect.id] = staticRect;
	document.objects[editedRect.id] = editedRect;
	layer.elementIds.push(staticRect.id, editedRect.id);
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
