import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../../document/factory";
import {
	createDefaultContentAppearance,
	type Document,
	type Filter,
	type Group,
	type Path,
	type PathSegment,
} from "../../../schema";
import { getTestDevice } from "../../../testUtils/shaderTestHarness";
import {
	captureTexturePixels,
	createTestRenderer,
} from "../../../testUtils/visualRegression";
import {
	FilterRenderer,
	type RegisterableFilterHandler,
	resolveRenderConfigure,
} from "../../canvas/pipeline/FilterRenderer";
import { BlurFilterHandler } from "../BlurFilter/BlurFilter";
import { DropShadowFilterHandler } from "../DropShadowFilter/DropShadowFilter";
import { HKChromaticAberrationFilterHandler } from "../HKChromaticAberrationFilter/HKChromaticAberrationFilter";
import { HKFluidFilterHandler } from "../HKFluidFilter/HKFluidFilter";
import { HKGradientMapFilterHandler } from "../HKGradientMapFilter/HKGradientMapFilter";
import { HKHuskyFilterHandler } from "../HKHuskyFilter/HKHuskyFilter";
import { HKKirakiraFilterHandler } from "../HKKirakiraFilter/HKKirakiraFilter";
import { HKSelectiveCorrectionFilterHandler } from "../HKSelectiveCorrectionFilter/HKSelectiveCorrectionFilter";
import { HKTurbulenceFilterHandler } from "../HKTurbulenceFilter/HKTurbulenceFilter";

const FORMAT: GPUTextureFormat = "rgba8unorm";
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const CACHE_TEXTURE_LABEL = "Filtered Element Cache Texture";
/** The whole bake, in texels at 1 texel per world px. */
const WHOLE = { width: 2048, height: 1536 };
/** A crop cut inside the whole bake on every side, on the 512-texel grid. */
const CROP = { x: 512, y: 512, width: 1024, height: 512 };
/** Width (texels) of the transparent border around the test picture. */
const SOURCE_BORDER = 256;
/** Spare texels a pool texture leaves right and below a bake. */
const POOL_PADDING = { x: 77, y: 45 };

/** Channel difference allowed by default: the rounding of positions a
 *  shader works out from the texture's size. */
const EXACT_DRIFT = 2;
/** Channel difference allowed for a chain with a blur pyramid. The pyramid
 *  maps each level by its rounded-up size, so its taps move by a fraction of
 *  a texel with the texture's size. */
const PYRAMID_DRIFT = 8;

/**
 * One case per filter that declares cropSafe: running its chain on a crop of
 * the whole bake, told where the crop sits, has to give the whole bake's pixels
 * everywhere the chain's reach stays inside the crop.
 */
const CASES: {
	name: string;
	handler: () => RegisterableFilterHandler;
	filter: Filter;
	drift: number;
}[] = [
	{
		name: "blur (direct kernel)",
		handler: () => new BlurFilterHandler(),
		filter: filter("blur", { radius: 5 }),
		drift: EXACT_DRIFT,
	},
	{
		name: "blur (pyramid)",
		handler: () => new BlurFilterHandler(),
		filter: filter("blur", { radius: 60 }),
		drift: PYRAMID_DRIFT,
	},
	{
		name: "drop-shadow",
		handler: () => new DropShadowFilterHandler(),
		filter: filter("drop-shadow", {
			offsetX: 12,
			offsetY: -9,
			blurRadius: 30,
			spreadRadius: 6,
			shadowOpacity: 0.7,
		}),
		drift: PYRAMID_DRIFT,
	},
	{
		name: "hk:kirakira",
		handler: () => new HKKirakiraFilterHandler(),
		filter: filter("hk:kirakira", {
			radius: 100,
			strength: 1,
			sparkle: 0.5,
			sparkleAlpha: false,
			blendOpacity: 1,
			makeOriginalTransparent: false,
			useCustomColor: false,
			customColor: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
		}),
		drift: PYRAMID_DRIFT,
	},
	{
		name: "hk:husky",
		handler: () => new HKHuskyFilterHandler(),
		filter: filter("hk:husky", {
			angle: 0,
			horizontalEnabled: true,
			verticalEnabled: true,
			blurIntensity: 5,
			bleedIntensity: 0.3,
			breathiness: 0.3,
			melt: 0.25,
			maxOffset: 20,
			randomSeed: 42,
		}),
		drift: EXACT_DRIFT,
	},
	{
		name: "hk:gradient-map",
		handler: () => new HKGradientMapFilterHandler(),
		filter: filter("hk:gradient-map", {
			preset: "blackAndWhite",
			colorStops: "[]",
			strength: 1,
		}),
		drift: EXACT_DRIFT,
	},
	{
		name: "hk:selective-correction",
		handler: () => new HKSelectiveCorrectionFilterHandler(),
		filter: filter("hk:selective-correction", {
			blendMode: "normal",
			mix: 1,
			featherEdges: 0.05,
			previewMask: false,
			useCondition: true,
			targetHue: 0,
			hueRange: 60,
			saturationMin: 0,
			saturationMax: 1,
			brightnessMin: 0,
			brightnessMax: 1,
			hueShift: 40,
			saturationScale: 1.2,
			vibrance: 0,
			brightnessScale: 1,
			contrast: 0.2,
		}),
		drift: EXACT_DRIFT,
	},
	{
		name: "hk:chromatic-aberration (zoom around a focus point)",
		handler: () => new HKChromaticAberrationFilterHandler(),
		filter: filter("hk:chromatic-aberration", {
			colorMode: "rgb",
			shiftType: "zoom",
			strength: 20,
			angle: 0,
			opacity: 1,
			blendMode: "over",
			useFocusPoint: true,
			focusPointX: 0.3,
			focusPointY: 0.6,
			focusGradient: 1,
		}),
		drift: EXACT_DRIFT,
	},
	{
		name: "hk:fluid",
		handler: () => new HKFluidFilterHandler(),
		filter: filter("hk:fluid", {
			intensity: 20,
			speed: 1,
			scale: 1,
			turbulence: 1,
			colorShift: 0.5,
			padding: 0,
			timeSeed: 0,
		}),
		drift: EXACT_DRIFT,
	},
	{
		name: "hk:turbulence (clamped)",
		handler: () => new HKTurbulenceFilterHandler(),
		filter: filter("hk:turbulence", {
			scale: 100,
			octaves: 4,
			seed: 42,
			displacementX: 30,
			displacementY: 30,
			displacementMode: "cartesian",
			edgeMode: "clamp",
			opacity: 1,
		}),
		drift: EXACT_DRIFT,
	},
];

describe("cropped filter bakes", () => {
	for (const { name, handler: createHandler, filter, drift } of CASES) {
		const reach =
			Math.ceil(createHandler().getBackdropFootprint(filter, WHOLE)) + 2;

		// A chain whose reach spans the element is never cut, so only its
		// padding is checked below.
		it.skipIf(CROP.height <= 2 * reach)(
			`should match the whole bake inside the reach for ${name}`,
			async () => {
				const { device, filterRenderer } = await setUpChain(
					createHandler,
					filter,
				);
				const source = createSourceTexture(device);
				const whole = await runChain(
					device,
					filterRenderer,
					filter,
					source,
					{ x: 0, y: 0, ...WHOLE },
					POOL_PADDING,
				);
				const cropped = await runChain(
					device,
					filterRenderer,
					filter,
					source,
					CROP,
					POOL_PADDING,
				);
				source.destroy();

				expect(maxDifferenceInside(whole, cropped, reach)).toBeLessThanOrEqual(
					drift,
				);
			},
			120_000,
		);

		it(`should ignore the pool padding around the bake for ${name}`, async () => {
			const { device, filterRenderer } = await setUpChain(
				createHandler,
				filter,
			);
			const source = createSourceTexture(device);
			const rect = { x: 0, y: 0, ...WHOLE };
			const padded = await runChain(
				device,
				filterRenderer,
				filter,
				source,
				rect,
				POOL_PADDING,
			);
			const exact = await runChain(
				device,
				filterRenderer,
				filter,
				source,
				rect,
				{
					x: 0,
					y: 0,
				},
			);
			source.destroy();

			expect(maxDifference(padded, exact)).toBeLessThanOrEqual(drift);
		}, 120_000);
	}

	it("should draw a kept bake cut to the view like the element's whole bake", async () => {
		const cut = await renderKeptBake(createLargeBlurDocument("clamp"));
		const whole = await renderKeptBake(createLargeBlurDocument("wrap"));

		expect(cut.cacheTexels).toBeLessThan(whole.cacheTexels);
		expect(maxDifference(cut.pixels, whole.pixels)).toBeLessThanOrEqual(
			EXACT_DRIFT,
		);
	}, 240_000);

	it("should bake a filtered child of a group only where the group's kept bake is cut", async () => {
		const cut = await renderKeptBake(createBlurredChildGroupDocument("clamp"));
		const whole = await renderKeptBake(createBlurredChildGroupDocument("wrap"));

		expect(cut.cacheTexels).toBeLessThan(whole.cacheTexels);
		expect(cut.blurTexels).toBeLessThan(whole.blurTexels);
		// The child's bake sits at another texel of its pool texture once it is
		// cut, which moves the taps of its blur pyramid.
		expect(maxDifference(cut.pixels, whole.pixels)).toBeLessThanOrEqual(
			PYRAMID_DRIFT,
		);
	}, 240_000);
});

// Helpers

/** Render `doc` at a view on the top-left part of its large rect, once its
 *  bake is in the cache, and report the size of that bake and of the largest
 *  texture its blur ran on. */
async function renderKeptBake(
	doc: Document,
): Promise<{ pixels: Uint8Array; cacheTexels: number; blurTexels: number }> {
	const { renderer } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("no GPU device");
	const blur = renderer.getFilterHandler("blur");
	if (!blur?.postProcess) throw new Error("blur handler not registered");
	let blurTexels = 0;
	const blurPostProcess = blur.postProcess;
	blur.postProcess = function measuredPostProcess(context, filter) {
		const { width, height } = context.sourceTexture;
		blurTexels = Math.max(blurTexels, width * height);
		return blurPostProcess.call(this, context, filter);
	};
	let cacheTexels = 0;
	const createTexture = device.createTexture.bind(device);
	device.createTexture = ((descriptor: GPUTextureDescriptor) => {
		const texture = createTexture(descriptor);
		if (descriptor.label === CACHE_TEXTURE_LABEL) {
			cacheTexels = Math.max(cacheTexels, texture.width * texture.height);
		}
		return texture;
	}) as typeof device.createTexture;

	const viewport = { x: -500, y: 300, zoom: 1, rotation: 0 };
	const unchanged = { upserted: new Set<string>(), deleted: new Set<string>() };
	let texture: GPUTexture | null = null;
	// The cache keeps a bake from the frame after the first one.
	for (let i = 0; i < 3; i++) {
		texture?.destroy();
		texture = await renderer.renderViewportToTexture(
			viewport,
			doc,
			CANVAS_WIDTH,
			CANVAS_HEIGHT,
			{ r: 1, g: 1, b: 1, a: 1 },
			unchanged,
			undefined,
			false,
			false,
		);
	}
	if (!texture) throw new Error("render returned no texture");
	const pixels = await captureTexturePixels(
		device,
		texture,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
	);
	texture.destroy();
	blur.postProcess = blurPostProcess;
	return { pixels, cacheTexels, blurTexels };
}

/** A blurred 1400 x 1000 rect, small enough that its whole bake fits the
 *  cache, ending in a turbulence that changes nothing. */
function createLargeBlurDocument(edgeMode: "clamp" | "wrap"): Document {
	const document = createDefaultDocument("cropped-bake");
	const layer = createDefaultLayer("layer-1", "Layer");
	const rect = largeBlurredRect([unchangingTurbulence(edgeMode)]);
	document.objects[rect.id] = rect;
	layer.elementIds.push(rect.id);
	document.layers = [layer];
	return document;
}

/** The blurred rect of createLargeBlurDocument as the only child of a group
 *  that carries the turbulence. */
function createBlurredChildGroupDocument(edgeMode: "clamp" | "wrap"): Document {
	const document = createDefaultDocument("cropped-group-bake");
	const layer = createDefaultLayer("layer-1", "Layer");
	const rect = largeBlurredRect([]);
	const group: Group = {
		id: "group-1",
		type: "group",
		childIds: [rect.id],
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		filters: [createDefaultContentAppearance(), unchangingTurbulence(edgeMode)],
	};
	document.objects[rect.id] = rect;
	document.objects[group.id] = group;
	layer.elementIds.push(group.id);
	document.layers = [layer];
	return document;
}

function largeBlurredRect(trailingFilters: Filter[]): Path {
	return {
		id: "large-blurred",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: rectSegments(-700, 700, -500, 500),
		filters: [
			{
				uid: "fill-1",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0.2, g: 0.5, b: 0.9, a: 1 },
						},
					},
				},
			},
			filter("blur", { radius: 20 }),
			...trailingFilters,
		],
	};
}

/** A turbulence at opacity 0, which leaves the picture alone. Clamped, it
 *  lets the renderer cut the bake to the view; wrapped, it forbids the cut. */
function unchangingTurbulence(edgeMode: "clamp" | "wrap"): Filter {
	return filter("hk:turbulence", {
		scale: 100,
		octaves: 4,
		seed: 42,
		displacementX: 30,
		displacementY: 30,
		displacementMode: "cartesian",
		edgeMode,
		opacity: 0,
	});
}

function maxDifference(a: Uint8Array, b: Uint8Array): number {
	let max = 0;
	for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
	return max;
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

function filter(processor: string, params: Record<string, unknown>): Filter {
	return {
		uid: `cropped-${processor}`,
		processor,
		enabled: true,
		paramData: { version: "1", params },
	} as unknown as Filter;
}

/** A registered handler for `filter`, after checking it declares cropSafe. */
async function setUpChain(
	createHandler: () => RegisterableFilterHandler,
	filter: Filter,
): Promise<{ device: GPUDevice; filterRenderer: FilterRenderer }> {
	const device = await getTestDevice();
	const filterRenderer = new FilterRenderer(device);
	const handler = createHandler();
	await handler.initialize(device, FORMAT);
	filterRenderer.registerHandler(filter.processor, handler);
	expect(resolveRenderConfigure(handler, filter).cropSafe).toBe(true);
	return { device, filterRenderer };
}

/** Run `filter` over the `rect` texels of `source`, placed on the whole bake.
 *  `padding` is the transparent margin right and below the bake, as a bake
 *  drawn into a pool texture has. */
async function runChain(
	device: GPUDevice,
	filterRenderer: FilterRenderer,
	filter: Filter,
	source: GPUTexture,
	rect: { x: number; y: number; width: number; height: number },
	padding: { x: number; y: number },
): Promise<Uint8Array> {
	const input = device.createTexture({
		size: { width: rect.width + padding.x, height: rect.height + padding.y },
		format: FORMAT,
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});
	filterRenderer.beginFrame();
	const encoder = device.createCommandEncoder();
	encoder.copyTextureToTexture(
		{ texture: source, origin: { x: rect.x, y: rect.y } },
		{ texture: input },
		{ width: rect.width, height: rect.height },
	);
	const { texture } = filterRenderer.applyFilters(
		input,
		[filter],
		encoder,
		undefined,
		1,
		{ width: rect.width, height: rect.height, texelOffset: { x: 0, y: 0 } },
		undefined,
		undefined,
		undefined,
		{ worldSize: WHOLE, sourceOffset: { x: rect.x, y: rect.y } },
	);
	device.queue.submit([encoder.finish()]);
	const pixels = await captureTexturePixels(
		device,
		texture,
		rect.width,
		rect.height,
	);
	input.destroy();
	return pixels;
}

/** Largest channel difference between the whole bake and the crop, over the
 *  crop less `inset` texels on each side. */
function maxDifferenceInside(
	whole: Uint8Array,
	cropped: Uint8Array,
	inset: number,
): number {
	let max = 0;
	for (let y = inset; y < CROP.height - inset; y++) {
		for (let x = inset; x < CROP.width - inset; x++) {
			const c = (y * CROP.width + x) * 4;
			const w = ((y + CROP.y) * WHOLE.width + x + CROP.x) * 4;
			for (let k = 0; k < 4; k++) {
				max = Math.max(max, Math.abs(whole[w + k] - cropped[c + k]));
			}
		}
	}
	return max;
}

/** Soft coloured discs and stripes with transparent gaps, so colour, alpha
 *  and silhouette edges all reach the filter. A transparent border stands in
 *  for the filter margin every whole bake has around its element. */
function createSourceTexture(device: GPUDevice): GPUTexture {
	const pixels = new Uint8Array(WHOLE.width * WHOLE.height * 4);
	for (let y = 0; y < WHOLE.height; y++) {
		for (let x = 0; x < WHOLE.width; x++) {
			const inBorder =
				Math.min(x, y, WHOLE.width - 1 - x, WHOLE.height - 1 - y) <
				SOURCE_BORDER;
			const disc =
				Math.hypot(((x % 300) - 150) / 110, ((y % 260) - 130) / 90) < 1;
			const stripe = (x + 2 * y) % 97 < 30;
			const alpha = inBorder ? 0 : disc ? 1 : stripe ? 0.6 : 0;
			const i = (y * WHOLE.width + x) * 4;
			pixels[i] = Math.round(((x * 7) % 256) * alpha);
			pixels[i + 1] = Math.round(((y * 5) % 256) * alpha);
			pixels[i + 2] = Math.round((((x + y) * 3) % 256) * alpha);
			pixels[i + 3] = Math.round(255 * alpha);
		}
	}
	const texture = device.createTexture({
		size: WHOLE,
		format: FORMAT,
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.COPY_DST,
	});
	device.queue.writeTexture(
		{ texture },
		pixels,
		{ bytesPerRow: WHOLE.width * 4 },
		WHOLE,
	);
	return texture;
}
