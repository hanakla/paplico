import pixelmatch from "pixelmatch";
import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type { FillAppearance, Path, PathSegment } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import type { DropShadowFilter } from "./DropShadowFilterProcessor";

describe("DropShadow - extreme viewport zoom", () => {
	it("should magnify the fixed-resolution shadow raster at 10x without clipping or stretching", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const document = createDocument();
		const background = { r: 1, g: 1, b: 1, a: 1 };
		const textureAt1x = await renderWithViewport(
			renderer,
			canvas,
			document,
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
			background,
		);
		const textureAt10x = await renderWithViewport(
			renderer,
			canvas,
			document,
			{ x: 0, y: 0, zoom: 10, rotation: 0 },
			background,
		);
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const pixelsAt1x = await captureTexturePixels(
			device,
			textureAt1x,
			textureAt1x.width,
			textureAt1x.height,
		);
		const pixelsAt10x = await captureTexturePixels(
			device,
			textureAt10x,
			textureAt10x.width,
			textureAt10x.height,
		);
		const visibleWorldWidth = textureAt10x.width / 10;
		const visibleWorldHeight = textureAt10x.height / 10;
		const expected = cropPixels(
			pixelsAt1x,
			textureAt1x.width,
			(textureAt1x.width - visibleWorldWidth) / 2,
			(textureAt1x.height - visibleWorldHeight) / 2,
			visibleWorldWidth,
			visibleWorldHeight,
		);
		const actual = downscaleByIntegerFactor(
			pixelsAt10x,
			textureAt10x.width,
			textureAt10x.height,
			10,
		);
		const diffPixels = pixelmatch(
			expected,
			actual,
			undefined,
			visibleWorldWidth,
			visibleWorldHeight,
			{ threshold: 0.2 },
		);

		expect(
			(diffPixels / (visibleWorldWidth * visibleWorldHeight)) * 100,
		).toBeLessThan(1);
		textureAt1x.destroy();
		textureAt10x.destroy();
	});
});

function createDocument() {
	const document = createDefaultDocument("drop-shadow-extreme-zoom-vrt");
	document.rasterizationDpi = 72;
	const layer = createDefaultLayer("layer-1", "Layer");
	const path: Path = {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: createSquareSegments(40),
		filters: [createFill(), createDropShadow()],
	};
	document.objects[path.id] = path;
	layer.elementIds.push(path.id);
	document.layers = [layer];
	return document;
}

function createFill(): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: 0.15, g: 0.45, b: 0.9, a: 1 },
				},
			},
		},
	};
}

function createDropShadow(): DropShadowFilter {
	return {
		uid: "shadow-1",
		processor: "drop-shadow",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				offsetX: 12,
				offsetY: -8,
				blurRadius: 6,
				spreadRadius: 2,
				shadowOpacity: 0.8,
				shadowColor: { type: "rgb", r: 0.7, g: 0.1, b: 0.15, a: 1 },
			},
		},
	};
}

function createSquareSegments(size: number): PathSegment[] {
	const half = size / 2;
	return [
		createLineSegment(-half, half, half, half, true),
		createLineSegment(half, half, half, -half, false),
		createLineSegment(half, -half, -half, -half, false),
		createLineSegment(-half, -half, -half, half, false, true),
	];
}

function createLineSegment(
	sx: number,
	sy: number,
	ex: number,
	ey: number,
	isMoved: boolean,
	isClosed = false,
): PathSegment {
	return {
		start: isMoved ? { x: sx, y: sy } : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: ex, y: ey },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved,
		isClosed,
	};
}

function cropPixels(
	source: Uint8Array,
	sourceWidth: number,
	x: number,
	y: number,
	width: number,
	height: number,
): Uint8Array {
	const cropped = new Uint8Array(width * height * 4);
	for (let row = 0; row < height; row++) {
		const sourceOffset = ((y + row) * sourceWidth + x) * 4;
		cropped.set(
			source.subarray(sourceOffset, sourceOffset + width * 4),
			row * width * 4,
		);
	}
	return cropped;
}

function downscaleByIntegerFactor(
	source: Uint8Array,
	sourceWidth: number,
	sourceHeight: number,
	factor: number,
): Uint8Array {
	const width = sourceWidth / factor;
	const height = sourceHeight / factor;
	const downscaled = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sums = [0, 0, 0, 0];
			for (let dy = 0; dy < factor; dy++) {
				for (let dx = 0; dx < factor; dx++) {
					const sourceOffset =
						((y * factor + dy) * sourceWidth + x * factor + dx) * 4;
					for (let channel = 0; channel < 4; channel++) {
						sums[channel] += source[sourceOffset + channel];
					}
				}
			}
			const destinationOffset = (y * width + x) * 4;
			for (let channel = 0; channel < 4; channel++) {
				downscaled[destinationOffset + channel] = Math.round(
					sums[channel] / (factor * factor),
				);
			}
		}
	}
	return downscaled;
}
