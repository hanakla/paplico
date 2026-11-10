import type { Paplico } from "@paplico/core";
import { proxy } from "valtio";
import {
	computeThumbnailRasterizationDpi,
	generateDocumentThumbnail,
} from "./generateDocumentThumbnail";

describe("computeThumbnailRasterizationDpi", () => {
	it("should use the thumbnail's pixel density when it is below the document's", () => {
		expect(computeThumbnailRasterizationDpi(300, 512 / 1920)).toBeCloseTo(19.2);
	});

	it("should keep the document's resolution when the thumbnail is denser", () => {
		expect(computeThumbnailRasterizationDpi(72, 2)).toBe(72);
	});

	it("should treat a document without a resolution as 72 dpi", () => {
		expect(computeThumbnailRasterizationDpi(undefined, 2)).toBe(72);
	});
});

describe("generateDocumentThumbnail", () => {
	it("should export the first artboard with filters at the thumbnail's pixel density", async () => {
		const blob = new Blob();
		const exportArtboard = vi.fn(async () => ({
			blob,
			width: 512,
			height: 288,
		}));
		const paplico = {
			uiState: proxy({
				document: {
					rasterizationDpi: 300,
					artboards: [{ id: "artboard-1", width: 1920, height: 1080 }],
					objects: {},
				},
			}),
			exportArtboard,
		} as unknown as Paplico;

		const result = await generateDocumentThumbnail(paplico);

		expect(result).toBe(blob);
		const [, artboardId, options] = exportArtboard.mock.calls[0] as unknown as [
			unknown,
			string,
			{ rasterizationDpi: number },
		];
		expect(artboardId).toBe("artboard-1");
		expect(options.rasterizationDpi).toBeCloseTo(19.2);
	});
});
