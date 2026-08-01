import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	convertImageRgbToRgb,
	convertImageToCmyk,
} from "../../color/ColorEngine";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type { Artboard, Document } from "../../schema";
import { PaplicoTIFFExporter } from "./PaplicoTIFFExporter";

vi.mock("../../color/ColorEngine", () => ({
	convertImageToCmyk: vi.fn(),
	convertImageRgbToRgb: vi.fn(),
}));

describe("PaplicoTIFFExporter", () => {
	const profile = buildIccHeader("CMYK");
	const rgbProfile = buildIccHeader("RGB ");

	// 2x2 RGBA: three opaque pixels + one semi-transparent pixel
	const makeRenderedImageData = (): ImageData =>
		({
			width: 2,
			height: 2,
			data: new Uint8ClampedArray([
				255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 100, 100, 100, 127,
			]),
		}) as ImageData;

	let mockRenderer: RenderOrchestrator;
	let exporter: PaplicoTIFFExporter;

	const createMockDocument = (): Document =>
		({
			id: "doc1",
			objects: {},
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			layers: [],
			files: [],
			artboards: [
				{
					id: "artboard1",
					name: "Test Artboard",
					x: 0,
					y: 0,
					width: 2,
					height: 2,
				},
			] as Artboard[],
			brushPresets: [],
		}) as Document;

	beforeEach(() => {
		vi.mocked(convertImageToCmyk).mockReset();
		vi.mocked(convertImageToCmyk).mockImplementation(async (rgba) =>
			new Uint8Array(rgba.length).fill(0x11),
		);
		vi.mocked(convertImageRgbToRgb).mockReset();
		vi.mocked(convertImageRgbToRgb).mockImplementation(async (rgba) =>
			new Uint8Array(rgba.length).fill(0x22),
		);

		mockRenderer = {
			renderArtboardToImageData: vi.fn(async () => makeRenderedImageData()),
		} as unknown as RenderOrchestrator;

		exporter = new PaplicoTIFFExporter(
			mockRenderer,
			createMockDocument,
			async () => new Uint8Array(16),
		);
	});

	describe("renderArtboardToTIFF", () => {
		it("should pass flattened opaque pixels and conversion options to convertImageToCmyk", async () => {
			await exporter.renderArtboardToTIFF("artboard1", {
				profile: { data: profile },
				srcSpace: "srgb",
				intent: "perceptual",
			});

			const [rgba, opts] = vi.mocked(convertImageToCmyk).mock.calls[0];

			// Opaque pixels pass through unchanged
			expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
			// Semi-transparent pixel is composited over the white background:
			// 100 * (127/255) + 255 * (128/255) = 177.8 -> 178
			expect([...rgba.subarray(12, 16)]).toEqual([178, 178, 178, 255]);

			expect(opts.srcSpace).toBe("srgb");
			expect(opts.intent).toBe("perceptual");
			expect(opts.profileBytes).toBe(profile);
		});

		it("should default to display-p3 source and relative-colorimetric intent", async () => {
			await exporter.renderArtboardToTIFF("artboard1", {
				profile: { data: profile },
			});

			const [, opts] = vi.mocked(convertImageToCmyk).mock.calls[0];
			expect(opts.srcSpace).toBe("display-p3");
			expect(opts.intent).toBe("relative-colorimetric");
		});

		it("should pass the rendered artboard and background color to the renderer", async () => {
			const backgroundColor = { r: 0, g: 0, b: 0, a: 1 };
			await exporter.renderArtboardToTIFF("artboard1", {
				profile: { data: profile },
				backgroundColor,
				scale: 2,
			});

			const call = vi.mocked(mockRenderer.renderArtboardToImageData).mock
				.calls[0];
			expect((call[0] as Artboard).id).toBe("artboard1");
			expect(call[2]).toBe(2);
			expect(call[3]).toBe(backgroundColor);
		});

		it("should produce a Blob with the little-endian TIFF signature", async () => {
			const result = await exporter.renderArtboardToTIFF("artboard1", {
				profile: { data: profile },
			});

			expect(result).not.toBeNull();
			expect(result?.width).toBe(2);
			expect(result?.height).toBe(2);
			expect(result?.blob.type).toBe("image/tiff");

			const bytes = new Uint8Array(await result!.blob.arrayBuffer());
			expect([...bytes.subarray(0, 4)]).toEqual([0x49, 0x49, 0x2a, 0x00]);
		});

		it("should write an RGB TIFF without converting to CMYK when no profile is given", async () => {
			const result = await exporter.renderArtboardToTIFF("artboard1", {});

			expect(vi.mocked(convertImageToCmyk).mock.calls).toHaveLength(0);
			expect(vi.mocked(convertImageRgbToRgb).mock.calls).toHaveLength(0);
			expect(result?.blob.type).toBe("image/tiff");

			const bytes = new Uint8Array(await result!.blob.arrayBuffer());
			expect([...bytes.subarray(0, 4)]).toEqual([0x49, 0x49, 0x2a, 0x00]);
		});

		it("should convert through an RGB profile and embed it as an RGB TIFF", async () => {
			const result = await exporter.renderArtboardToTIFF("artboard1", {
				profile: { data: rgbProfile },
			});

			expect(vi.mocked(convertImageRgbToRgb).mock.calls).toHaveLength(1);
			expect(vi.mocked(convertImageToCmyk).mock.calls).toHaveLength(0);
			const [, opts] = vi.mocked(convertImageRgbToRgb).mock.calls[0];
			expect(opts.dstProfileBytes).toBe(rgbProfile);
			expect(result?.blob.type).toBe("image/tiff");
		});

		it("should return null when the artboard is not found", async () => {
			const result = await exporter.renderArtboardToTIFF("nonexistent", {
				profile: { data: profile },
			});

			expect(result).toBeNull();
			expect(vi.mocked(convertImageToCmyk).mock.calls).toHaveLength(0);
		});

		it("should return null when rendering fails", async () => {
			vi.mocked(mockRenderer.renderArtboardToImageData).mockResolvedValueOnce(
				null,
			);

			const result = await exporter.renderArtboardToTIFF("artboard1", {
				profile: { data: profile },
			});

			expect(result).toBeNull();
		});
	});

	describe("asTIFF", () => {
		it("should return false for non-existent artboard", async () => {
			const result = await exporter.asTIFF("nonexistent", {
				profile: { data: profile },
			});

			expect(result).toBe(false);
		});
	});
});

/** Minimal 128-byte ICC header: data color space at offset 16, 'acsp' at 36. */
function buildIccHeader(colorSpace: "RGB " | "CMYK"): Uint8Array {
	const bytes = new Uint8Array(128);
	writeSignature(bytes, 16, colorSpace);
	writeSignature(bytes, 36, "acsp");
	return bytes;
}

function writeSignature(bytes: Uint8Array, offset: number, sig: string): void {
	for (let i = 0; i < 4; i++) bytes[offset + i] = sig.charCodeAt(i);
}
