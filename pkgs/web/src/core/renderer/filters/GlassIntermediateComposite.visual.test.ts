import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	Document,
	Extrude3DAppearance,
	FillAppearance,
	Path,
	PathSegment,
	RawRGBA,
	Viewport,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";
import type { BlurFilter } from "./BlurFilterProcessor";

const WIDTH = 800;
const HEIGHT = 600;
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };
const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

// A glass extrude with a downstream filter goes through the intermediate
// texture route (composeInline → filteredGlass → applyFilters → canvas
// blit). The blit must replace the backdrop within the solid's coverage;
// keying src-over on the filtered alpha instead leaks the sharp backdrop
// wherever the refracted result is translucent — visible on transparent
// grounds only.

describe("glass extrude intermediate composite", () => {
	it("should flatten a transparent-ground render over white to match the white-ground render inside the solid", async () => {
		const { renderer } = await createTestRenderer();
		const doc = createGlassDoc(4);
		const transparent = await renderFrame(renderer, doc, {
			r: 0,
			g: 0,
			b: 0,
			a: 0,
		});
		const opaque = await renderFrame(renderer, doc, { r: 1, g: 1, b: 1, a: 1 });

		// Glass solid spans world [-50,50]² → screen [350,450]x[250,350].
		// A 15px inset keeps the comparison off the coverage fringe and out
		// of the downstream blur's reach from it.
		let maxDiff = 0;
		for (let y = 265; y < 335; y++) {
			for (let x = 365; x < 435; x++) {
				const i = (y * WIDTH + x) * 4;
				const a = transparent[i + 3] / 255;
				for (let c = 0; c < 3; c++) {
					const flattened = transparent[i + c] + 255 * (1 - a);
					maxDiff = Math.max(maxDiff, Math.abs(flattened - opaque[i + c]));
				}
			}
		}
		expect(maxDiff).toBeLessThanOrEqual(6);
	});

	it("should refract earlier glass instances through later ones in the intermediate batch", async () => {
		// Two glass extrudes on one path make a multi-entry batch. Routed
		// through the intermediate texture (a near-no-op downstream blur),
		// the batch must reproduce the direct route, where the second glass
		// recaptures and refracts the first one's output — composing each
		// entry against the raw canvas instead drops the first glass from
		// under the second.
		const { renderer: intermediateRenderer } = await createTestRenderer();
		const intermediate = await renderFrame(
			intermediateRenderer,
			createGlassDoc(0.5, 2),
			{ r: 0, g: 0, b: 0, a: 0 },
		);
		const { renderer: directRenderer } = await createTestRenderer();
		const direct = await renderFrame(directRenderer, createGlassDoc(null, 2), {
			r: 0,
			g: 0,
			b: 0,
			a: 0,
		});

		// Interior of the solid (fringe excluded). The 0.5px downstream blur
		// keeps a few units of drift, so count meaningful disagreements
		// instead of asserting exact equality.
		let differing = 0;
		let compared = 0;
		for (let y = 265; y < 335; y++) {
			for (let x = 365; x < 435; x++) {
				const i = (y * WIDTH + x) * 4;
				compared++;
				for (let c = 0; c < 4; c++) {
					if (Math.abs(intermediate[i + c] - direct[i + c]) > 12) {
						differing++;
						break;
					}
				}
			}
		}
		expect((differing / compared) * 100).toBeLessThan(1);
	});

	it("should keep the downstream blur spreading past the solid", async () => {
		// Guards the composite's keep-spread semantics: content a downstream
		// filter pushes outside the solid (coverage 0) must still show up,
		// not be clipped at the solid edge.
		const { renderer } = await createTestRenderer();
		const doc = createGlassDoc(12);
		const pixels = await renderFrame(renderer, doc, { r: 0, g: 0, b: 0, a: 0 });

		// Solid's right edge is at screen x=450; the backdrop rect stays on
		// the left half, so alpha out here can only come from spread glass.
		let spreadAlpha = 0;
		for (let x = 452; x < 462; x++) {
			spreadAlpha = Math.max(spreadAlpha, pixels[(300 * WIDTH + x) * 4 + 3]);
		}
		expect(spreadAlpha).toBeGreaterThan(0);
	});
});

async function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	background: RawRGBA,
): Promise<Uint8Array> {
	// The extrude mesh bakes asynchronously — the first frame can miss the
	// glass entirely (same warm-up as ExtrudeStability), so render twice and
	// measure the second frame.
	let texture: GPUTexture | null = null;
	for (let frame = 0; frame < 2; frame++) {
		texture?.destroy();
		texture = await renderer.renderViewportToTexture(
			VIEWPORT,
			doc,
			WIDTH,
			HEIGHT,
			background,
			UNCHANGED,
			undefined,
			false,
		);
		if (!texture) throw new Error("render returned no texture");
	}
	const device = renderer.getDevice();
	if (!device) throw new Error("no GPU device");
	const pixels = await captureTexturePixels(device, texture!, WIDTH, HEIGHT);
	texture!.destroy();

	// Guard against a vacuous pass: the glass solid must actually be there.
	// (430,300) sits inside the solid but right of the backdrop rect, so on
	// any ground the glass surface itself must have produced coverage.
	if (pixels[(300 * WIDTH + 430) * 4 + 3] === 0 && background.a === 0) {
		throw new Error("glass solid did not render — bake warm-up insufficient");
	}
	return pixels;
}

function createGlassDoc(blurRadius: number | null, glassCount = 1): Document {
	const doc = createDefaultDocument("glass-intermediate-vrt");
	const layer = createDefaultLayer("layer-1", "Layer");
	// Opaque backdrop whose right edge (world x=10) runs under the glass, so
	// the backdrop under the solid carries an alpha edge on transparent
	// grounds.
	const backdrop = createFilledPath("bg-1", rectSegments(-30, 0, 80, 300), {
		r: 0.1,
		g: 0.2,
		b: 0.7,
		a: 1,
	});
	const glass = createGlassPath(blurRadius, glassCount);
	for (const element of [backdrop, glass]) {
		doc.objects[element.id] = element;
		layer.elementIds.push(element.id);
	}
	doc.layers = [layer];
	return doc;
}

function createGlassPath(blurRadius: number | null, glassCount = 1): Path {
	const fill: FillAppearance = {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					// Translucent surface: the refracted backdrop must show
					// through for its alpha to reach the composite.
					color: { type: "rgb", r: 0.8, g: 0.8, b: 0.8, a: 0.25 },
				},
			},
		},
	};
	const glassApps = Array.from(
		{ length: glassCount },
		(_, i): Extrude3DAppearance => ({
			uid: `extrude-${i + 1}`,
			processor: "extrude3d",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					depth: 40 + i * 40,
					rotationDeg: [0, 0, 0],
					perspective: 20,
					material: {
						shading: "lambert",
						lightDir: [0, 0, 1],
						refraction: 1.5,
						// Frosted glass: blurring the backdrop is what softens its
						// alpha edge under the solid — the precondition for the
						// src-over leak this suite guards against.
						blur: 6 - i * 2,
					},
				},
			},
		}),
	);
	// A downstream blur is what routes the glass through the intermediate
	// texture; null keeps the direct route.
	const downstream: BlurFilter[] =
		blurRadius === null
			? []
			: [
					{
						uid: "blur-1",
						processor: "blur",
						opacity: 1,
						blendMode: "normal",
						enabled: true,
						paramData: { version: "1", params: { radius: blurRadius } },
					},
				];
	return {
		id: "glass-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(0, 0, 100, 100),
		filters: [fill, ...glassApps, ...downstream],
	};
}

function createFilledPath(
	id: string,
	segments: PathSegment[],
	color: { r: number; g: number; b: number; a: number },
): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments,
		filters: [
			{
				uid: `${id}-fill`,
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: { type: "solid", color: { type: "rgb", ...color } },
					},
				},
			} satisfies FillAppearance,
		],
	};
}

function rectSegments(
	cx: number,
	cy: number,
	w: number,
	h: number,
): PathSegment[] {
	const points = [
		{ x: cx - w / 2, y: cy + h / 2 },
		{ x: cx + w / 2, y: cy + h / 2 },
		{ x: cx + w / 2, y: cy - h / 2 },
		{ x: cx - w / 2, y: cy - h / 2 },
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
		isClosed: index === points.length - 1 ? true : undefined,
	}));
}
