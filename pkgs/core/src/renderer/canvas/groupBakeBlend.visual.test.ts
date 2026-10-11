import { describe, expect, it } from "vitest";
import {
	type BlendMode,
	createDefaultContentAppearance,
	type Document,
	type FillAppearance,
	type Filter,
	type Group,
	type Path,
	type RawRGBA,
	type Viewport,
} from "../../schema";
import {
	mockDocument,
	mockGroup,
	mockLayer,
	mockPath,
} from "../../testUtils/mockElements";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../testUtils/visualRegression";
import type { CanvasTarget } from "../CanvasTarget";

/** World (0, 0) sits at screen (400, 300), one world unit per pixel. */
const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
const BACKDROP: RawRGBA = { r: 0.5, g: 0.75, b: 1, a: 1 };
const BASE: RawRGBA = { r: 0.8, g: 0.8, b: 0.2, a: 1 };
const TINT: RawRGBA = { r: 1, g: 0.5, b: 0.5, a: 1 };
/** One 8-bit step of rounding on each side of a blend. */
const TOLERANCE = 2.5 / 255;

/** Inside the base, where the tint lies over it. */
const OVER_BASE: [number, number] = [-25, 0];
/** Inside the tint, past the base's edge. */
const OVER_NOTHING: [number, number] = [25, 0];
/** Inside the base, clear of the tint. */
const BASE_ONLY: [number, number] = [-75, 0];

/**
 * A group drawn from a bake is one isolated layer: its children blend against
 * what the group itself holds, and the result goes over the document.
 *
 *   x: -100 ..  0    base
 *   x:  -50 .. 50    multiply tint (y -30..30)
 *
 * The group filters are weak enough to leave the sampled points, each at
 * least 20 units from an edge, at their unfiltered colour.
 */
describe("blend modes inside a baked group", () => {
	for (const [name, groupFilter] of [
		["a chromatic aberration", chromaticAberration],
		["a blur", blur],
	] as const) {
		describe(`under ${name} on the group`, () => {
			it("should blend a child against the group's content", async () => {
				const pixels = await render(
					bakedDocument({ group: { filters: [groupFilter("group")] } }),
				);

				expectColor(colorAtWorld(pixels, ...OVER_BASE), multiply(BASE, TINT));
				expectColor(colorAtWorld(pixels, ...OVER_NOTHING), TINT);
			});

			it("should blend a child that has a filter of its own", async () => {
				const pixels = await render(
					bakedDocument({
						group: { filters: [groupFilter("group")] },
						tintFilters: [blur("tint")],
					}),
				);

				expectColor(colorAtWorld(pixels, ...OVER_BASE), multiply(BASE, TINT));
			});

			it("should blend a child of a nested group", async () => {
				const pixels = await render(
					bakedDocument({
						group: { filters: [groupFilter("group")] },
						nestTint: true,
					}),
				);

				expectColor(colorAtWorld(pixels, ...OVER_BASE), multiply(BASE, TINT));
			});

			it("should blend a fill against the fills beneath it", async () => {
				const pixels = await render(
					bakedDocument({
						group: { filters: [groupFilter("group")] },
						baseFills: [fill("base-a", BASE), fill("base-b", TINT, "multiply")],
					}),
				);

				expectColor(colorAtWorld(pixels, ...BASE_ONLY), multiply(BASE, TINT));
			});
		});
	}

	describe("under an opacity on the group", () => {
		it("should blend a child against the group's content", async () => {
			const pixels = await render(bakedDocument({ group: { opacity: 0.5 } }));

			expectColor(
				colorAtWorld(pixels, ...OVER_BASE),
				mix(BACKDROP, multiply(BASE, TINT), 0.5),
			);
		});

		it("should blend a fill against the fills beneath it", async () => {
			const pixels = await render(
				bakedDocument({
					group: { opacity: 0.5 },
					baseFills: [fill("base-a", BASE), fill("base-b", TINT, "multiply")],
				}),
			);

			expectColor(
				colorAtWorld(pixels, ...BASE_ONLY),
				mix(BACKDROP, multiply(BASE, TINT), 0.5),
			);
		});
	});
});

describe("filters inside a baked group", () => {
	it("should keep the blur of a child of a nested group", async () => {
		// The halo of the blurred tint, 4 units past its top edge and still
		// inside the group's bounds.
		const halo: [number, number] = [25, 34];
		const nested: Parameters<typeof bakedDocument>[0] = {
			nestTint: true,
			tintBlendMode: "normal",
			tintFilters: [blur("tint", 8)],
		};
		const plain = await render(bakedDocument(nested));
		const baked = await render(
			bakedDocument({ ...nested, group: { opacity: 0.999 } }),
		);

		expect(colorAtWorld(plain, ...halo)).not.toEqual(BACKDROP);
		expectColor(colorAtWorld(baked, ...halo), colorAtWorld(plain, ...halo));
	});
});

function bakedDocument({
	group: groupOverrides = {},
	baseFills,
	tintFilters = [],
	tintBlendMode = "multiply",
	nestTint = false,
}: {
	group?: { filters?: Filter[]; opacity?: number };
	/** Replaces the base's single fill. */
	baseFills?: FillAppearance[];
	tintFilters?: Filter[];
	tintBlendMode?: BlendMode;
	nestTint?: boolean;
}): Document {
	const backdrop = filledRect("backdrop-1", [-300, -200, 300, 200], BACKDROP);
	const base = filledRect("base-1", [-100, -50, 0, 50], BASE);
	if (baseFills) base.filters = baseFills;
	const tint = filledRect("tint-1", [-50, -30, 50, 30], TINT, tintBlendMode);
	tint.filters = [...(tint.filters ?? []), ...tintFilters];
	// A fill-blend case needs the base alone; the tint would cover it.
	tint.visible = baseFills == null;
	const nested = mockGroup("nested-1", [tint.id]);
	nested.filters = [createDefaultContentAppearance()];

	const group: Group = {
		...mockGroup("group-1", [base.id, nestTint ? nested.id : tint.id]),
		opacity: groupOverrides.opacity ?? 1,
		filters: [
			createDefaultContentAppearance(),
			...(groupOverrides.filters ?? []),
		],
	};
	return mockDocument(
		[backdrop, base, tint, nested, group],
		[mockLayer("layer-1", [backdrop.id, group.id])],
	);
}

function chromaticAberration(id: string): Filter {
	return {
		uid: `chromatic-aberration-${id}`,
		processor: "hk:chromatic-aberration",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				colorMode: "rgb",
				shiftType: "move",
				strength: 5,
				angle: 0,
				opacity: 1,
				blendMode: "over",
				useFocusPoint: false,
				focusPointX: 0.5,
				focusPointY: 0.5,
				focusGradient: 1,
			},
		},
	};
}

function blur(id: string, radius = 2): Filter {
	return {
		uid: `blur-${id}`,
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { radius } },
	};
}

function fill(
	uid: string,
	color: RawRGBA,
	blendMode: BlendMode = "normal",
): FillAppearance {
	return {
		uid,
		processor: "fill",
		opacity: 1,
		blendMode,
		paramData: {
			version: "1",
			params: { fill: { type: "solid", color: { type: "rgb", ...color } } },
		},
	};
}

function filledRect(
	id: string,
	[minX, minY, maxX, maxY]: [number, number, number, number],
	color: RawRGBA,
	blendMode: BlendMode = "normal",
): Path {
	const path = mockPath(id);
	path.segments = closedRectSegments(minX, minY, maxX, maxY);
	path.blendMode = blendMode;
	path.filters = [fill(`${id}-fill`, color)];
	return path;
}

/** Render through RenderOrchestrator.render, the path the editor draws
 *  with, and read back the presented frame. */
async function render(document: Document): Promise<Uint8Array> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	renderer.render(
		{
			viewport: VIEWPORT,
			document,
			strategy: "full",
			changedElements: { upserted: new Set(), deleted: new Set() },
		},
		{},
	);
	await device.queue.onSubmittedWorkDone();
	const texture = presentedTexture(canvas);
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	if (texture.format.startsWith("bgra")) {
		for (let offset = 0; offset < pixels.length; offset += 4) {
			[pixels[offset], pixels[offset + 2]] = [
				pixels[offset + 2],
				pixels[offset],
			];
		}
	}
	return pixels;
}

function presentedTexture(canvas: CanvasTarget): GPUTexture {
	return (
		canvas as unknown as { _context: GPUCanvasContext }
	)._context.getCurrentTexture();
}

function colorAtWorld(pixels: Uint8Array, x: number, y: number): RawRGBA {
	const offset = ((300 - y) * 800 + (400 + x)) * 4;
	return {
		r: pixels[offset] / 255,
		g: pixels[offset + 1] / 255,
		b: pixels[offset + 2] / 255,
		a: pixels[offset + 3] / 255,
	};
}

function multiply(backdrop: RawRGBA, source: RawRGBA): RawRGBA {
	return {
		r: backdrop.r * source.r,
		g: backdrop.g * source.g,
		b: backdrop.b * source.b,
		a: 1,
	};
}

function mix(under: RawRGBA, over: RawRGBA, amount: number): RawRGBA {
	return {
		r: under.r + (over.r - under.r) * amount,
		g: under.g + (over.g - under.g) * amount,
		b: under.b + (over.b - under.b) * amount,
		a: 1,
	};
}

function expectColor(actual: RawRGBA, expected: RawRGBA): void {
	expect(Math.abs(actual.r - expected.r)).toBeLessThan(TOLERANCE);
	expect(Math.abs(actual.g - expected.g)).toBeLessThan(TOLERANCE);
	expect(Math.abs(actual.b - expected.b)).toBeLessThan(TOLERANCE);
}
