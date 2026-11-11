import { describe, expect, it } from "vitest";
import {
	type BlendMode,
	createDefaultContentAppearance,
	type Document,
	type FillAppearance,
	type Filter,
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
import type { DropShadowFilter } from "../filters/DropShadowFilter/DropShadowFilter";

/** World (0, 0) sits at screen (400, 300), one world unit per pixel. */
const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
const BACKDROP: RawRGBA = { r: 0.5, g: 0.75, b: 1, a: 1 };
const BASE: RawRGBA = { r: 0.8, g: 0.8, b: 0.2, a: 1 };
const TINT: RawRGBA = { r: 1, g: 0.5, b: 0.5, a: 1 };
const HIDDEN: RawRGBA = { r: 0, g: 1, b: 0, a: 1 };
/** The shadow is thrown this far to the right, clear of the group itself. */
const SHADOW_OFFSET = 150;
/** One 8-bit step of rounding on each side of a blend. */
const TOLERANCE = 2.5 / 255;

/**
 * A group holding a base square and a multiply square that reaches past the
 * base onto the backdrop, over a backdrop drawn beneath the group:
 *
 *   x: -100 .. -20   base
 *   x:  -60 ..  60   multiply tint (y -20..20)
 *   x:   50 .. 130   the base's shadow
 *
 * A blurred square sits below them and a hidden one above.
 */
describe("drop shadow on a group", () => {
	it("should blend a child against the document beneath the group", async () => {
		const { pixels } = await renderFrames(shadowedDocument(), 1);

		const overBackdrop = colorAtWorld(pixels, 10, 0);
		expect(overBackdrop.r).toBeCloseTo(BACKDROP.r * TINT.r, 1);
		expect(overBackdrop.g).toBeCloseTo(BACKDROP.g * TINT.g, 1);
		expect(overBackdrop.b).toBeCloseTo(BACKDROP.b * TINT.b, 1);
	});

	it("should draw the group's content the same as it does without the shadow", async () => {
		const { pixels: plain } = await renderFrames(
			shadowedDocument({ shadow: false }),
			1,
		);
		const { pixels: shadowed } = await renderFrames(shadowedDocument(), 1);

		// Blend over the backdrop, blend over the base, the bare base, and the
		// halo of the blurred child.
		for (const [x, y] of [
			[10, 0],
			[-40, 0],
			[-80, 30],
			[-54, -100],
		]) {
			expectSameColor(colorAtWorld(shadowed, x, y), colorAtWorld(plain, x, y));
		}
	});

	it("should cast the shadow beneath the group", async () => {
		const { pixels } = await renderFrames(shadowedDocument(), 1);

		const shadow = colorAtWorld(pixels, -60 + SHADOW_OFFSET, 30);
		expect(shadow.r).toBeLessThan(0.05);
		expect(shadow.g).toBeLessThan(0.05);
		expect(shadow.b).toBeLessThan(0.05);
	});

	it("should neither draw a hidden child nor cast a shadow from it", async () => {
		const { pixels } = await renderFrames(shadowedDocument(), 1);

		expectSameColor(colorAtWorld(pixels, -60, 90), BACKDROP);
		expectSameColor(colorAtWorld(pixels, -60 + SHADOW_OFFSET, 90), BACKDROP);
	});

	it("should render the same frame again from its cached shadow", async () => {
		const first = await renderFrames(shadowedDocument(), 1);
		const repeated = await renderFrames(shadowedDocument(), 3);

		// The first frame builds the shadow; a repeated one must not.
		expect(first.shadowPasses).toBeGreaterThan(0);
		expect(repeated.shadowPasses).toBe(0);
		for (const [x, y] of [
			[10, 0],
			[-40, 0],
			[-60 + SHADOW_OFFSET, 30],
			[-60, 90],
		]) {
			expectSameColor(
				colorAtWorld(repeated.pixels, x, y),
				colorAtWorld(first.pixels, x, y),
			);
		}
	});
});

function shadowedDocument({ shadow = true } = {}): Document {
	const backdrop = filledRect("backdrop-1", [-300, -200, 300, 200], BACKDROP);
	const base = filledRect("base-1", [-100, -40, -20, 40], BASE);
	const tint = filledRect("tint-1", [-60, -20, 60, 20], TINT, "multiply");
	const hidden = filledRect("hidden-1", [-100, 60, -20, 120], HIDDEN);
	hidden.visible = false;
	const blurred = filledRect("blurred-1", [-100, -120, -60, -80], BASE);
	blurred.filters = [...(blurred.filters ?? []), blur()];

	const group = mockGroup("group-1", [base.id, tint.id, hidden.id, blurred.id]);
	group.filters = [
		createDefaultContentAppearance(),
		...(shadow ? [dropShadow()] : []),
	];
	return mockDocument(
		[backdrop, base, tint, hidden, blurred, group],
		[mockLayer("layer-1", [backdrop.id, group.id])],
	);
}

function dropShadow(): DropShadowFilter {
	return {
		uid: "shadow-1",
		processor: "drop-shadow",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				offsetX: SHADOW_OFFSET,
				offsetY: 0,
				blurRadius: 2,
				shadowOpacity: 1,
			},
		},
	};
}

function blur(): Filter {
	return {
		uid: "blur-1",
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { radius: 8 } },
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
	const fill: FillAppearance = {
		uid: `${id}-fill`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { fill: { type: "solid", color: { type: "rgb", ...color } } },
		},
	};
	path.filters = [fill];
	return path;
}

/** Render `frames` times through RenderOrchestrator.render, the path the
 *  editor draws with. Returns the last presented frame and how many drop
 *  shadow passes that frame encoded. */
async function renderFrames(
	document: Document,
	frames: number,
): Promise<{ pixels: Uint8Array; shadowPasses: number }> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	const shadowPasses = trackShadowPasses(device);
	for (let frame = 0; frame < frames; frame++) {
		shadowPasses.count = 0;
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
	}
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
	return { pixels, shadowPasses: shadowPasses.count };
}

function trackShadowPasses(device: GPUDevice): { count: number } {
	const counter = { count: 0 };
	const createEncoder = device.createCommandEncoder.bind(device);
	device.createCommandEncoder = ((descriptor?: GPUCommandEncoderDescriptor) => {
		const encoder = createEncoder(descriptor);
		const beginRenderPass = encoder.beginRenderPass.bind(encoder);
		encoder.beginRenderPass = ((pass: GPURenderPassDescriptor) => {
			if (pass.label?.startsWith("Drop Shadow")) counter.count++;
			return beginRenderPass(pass);
		}) as typeof encoder.beginRenderPass;
		return encoder;
	}) as typeof device.createCommandEncoder;
	return counter;
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

function expectSameColor(actual: RawRGBA, expected: RawRGBA): void {
	expect(Math.abs(actual.r - expected.r)).toBeLessThan(TOLERANCE);
	expect(Math.abs(actual.g - expected.g)).toBeLessThan(TOLERANCE);
	expect(Math.abs(actual.b - expected.b)).toBeLessThan(TOLERANCE);
}
