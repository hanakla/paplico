import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultBrushSettings } from "@/core/document/factory";
import { BrushStrokePreview } from "@/organisms/Toolbar/BrushTools";

const mockRenderBrushStrokePreviewToImageData =
	vi.fn<(options: unknown) => Promise<ImageData | null>>();

let mockPaplico: {
	renderBrushStrokePreviewToImageData: typeof mockRenderBrushStrokePreviewToImageData;
} | null = null;

vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplicoMaybe: () => mockPaplico,
}));

describe("BrushStrokePreview", () => {
	beforeEach(() => {
		mockPaplico = {
			renderBrushStrokePreviewToImageData:
				mockRenderBrushStrokePreviewToImageData,
		};
		mockRenderBrushStrokePreviewToImageData.mockReset();
		const mockContext = {
			clearRect: vi.fn(),
			putImageData: vi.fn(),
			fillRect: vi.fn(),
			get fillStyle() {
				return "";
			},
			set fillStyle(_: string) {},
			getImageData: vi
				.fn()
				.mockReturnValue({ data: new Uint8ClampedArray([17, 24, 39, 255]) }),
		};
		vi.spyOn(
			HTMLCanvasElement.prototype as any,
			"getContext",
		).mockImplementation((contextId: string) => {
			return contextId === "2d"
				? (mockContext as unknown as CanvasRenderingContext2D)
				: null;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should request engine preview rendering when paplico is ready", async () => {
		mockRenderBrushStrokePreviewToImageData.mockResolvedValue(
			new ImageData(8, 2),
		);

		render(
			<BrushStrokePreview
				brushSettings={createDefaultBrushSettings()}
				textureFile={{
					uid: "preview-file",
					name: "preview.png",
					type: "image/png",
					hash: "preview-hash",
					bin: Uint8Array.from([1, 2, 3]),
				}}
				width={72}
				height={32}
			/>,
		);

		await waitFor(() => {
			expect(mockRenderBrushStrokePreviewToImageData).toHaveBeenCalled();
		});

		const lastCall =
			mockRenderBrushStrokePreviewToImageData.mock.calls.at(-1)?.[0];

		expect(lastCall).toMatchObject({
			width: 72,
			height: 32,
			textureFile: expect.objectContaining({
				hash: "preview-hash",
			}),
		});
	});

	it("should show the thumbnail fallback while paplico is unavailable", () => {
		mockPaplico = null;

		const { container } = render(
			<BrushStrokePreview
				brushSettings={createDefaultBrushSettings()}
				textureFile={{
					uid: "preview-file",
					name: "preview.png",
					type: "image/png",
					hash: "preview-hash",
					bin: Uint8Array.from([1, 2, 3]),
				}}
				width={72}
				height={32}
			/>,
		);

		// When paplico is unavailable, the canvas stays hidden and the thumbnail fallback is shown
		const canvas = container.querySelector("canvas");
		expect(canvas?.classList.contains("opacity-0")).toBe(true);

		const fallback = container.querySelector(".absolute.inset-0");
		expect(fallback).not.toBeNull();
	});
});
