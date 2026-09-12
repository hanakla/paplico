import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { isPaplicoError } from "../../errors";
import type { Document } from "../../schema";
import { openPapfContainer, wrapPapfInPdf } from "./pdfContainer";
import { serializeDocument } from "./writer";

describe("PDF container", () => {
	describe("wrapPapfInPdf", () => {
		it("should produce a PDF with one page per preview page", async () => {
			const pdf = await wrapPapfInPdf(await papfBytes(), [
				{ width: 200, height: 100, jpeg: makeJpeg() },
				{ width: 300, height: 400, jpeg: null },
			]);
			const bytes = new Uint8Array(await pdf.arrayBuffer());
			expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");

			const parsed = await PDFDocument.load(bytes);
			const pages = parsed.getPages();
			expect(pages).toHaveLength(2);
			expect(pages[0].getSize()).toEqual({ width: 200, height: 100 });
			expect(pages[1].getSize()).toEqual({ width: 300, height: 400 });
		});

		it("should add a blank page when there are no artboards", async () => {
			const pdf = await wrapPapfInPdf(await papfBytes(), []);
			const parsed = await PDFDocument.load(await pdf.arrayBuffer());
			expect(parsed.getPageCount()).toBe(1);
		});

		it("should store the papf bytes verbatim under PieceInfo", async () => {
			const papf = await papfBytes();
			const pdf = await wrapPapfInPdf(papf, []);
			const parsed = await PDFDocument.load(await pdf.arrayBuffer());
			const stream = parsed.catalog
				.lookup(PDFName.of("PieceInfo"), PDFDict)
				.lookup(PDFName.of("Paplico"), PDFDict)
				.lookup(PDFName.of("Private"));
			if (!(stream instanceof PDFRawStream)) throw new Error("not a stream");
			expect(stream.contents).toEqual(papf);
		});
	});

	describe("openPapfContainer", () => {
		it("should round-trip a document through the PDF container", async () => {
			const doc = makeDoc();
			const pdf = await wrapPapfInPdf(await papfBytes(doc), [
				{ width: 200, height: 100, jpeg: makeJpeg() },
			]);
			const restored = await (await openPapfContainer(pdf)).toDocument();
			expect(restored.id).toBe(doc.id);
			expect(restored.artboards).toEqual(doc.artboards);
		});

		it("should open a raw papf as-is", async () => {
			const doc = makeDoc();
			const restored = await (
				await openPapfContainer(await serializeDocument(doc))
			).toDocument();
			expect(restored.id).toBe(doc.id);
		});

		it("should read a papf stream re-encoded with FlateDecode", async () => {
			const doc = makeDoc();
			const papf = await papfBytes(doc);
			const pdf = await PDFDocument.create();
			pdf.addPage();
			pdf.catalog.set(
				PDFName.of("PieceInfo"),
				pdf.context.obj({
					Paplico: {
						Private: pdf.context.register(pdf.context.flateStream(papf)),
					},
				}),
			);
			const bytes = await pdf.save({ useObjectStreams: false });
			const restored = await (
				await openPapfContainer(new Blob([bytes as Uint8Array<ArrayBuffer>]))
			).toDocument();
			expect(restored.id).toBe(doc.id);
		});

		it("should reject a PDF without Paplico data with PAPF_NOT_FOUND_IN_PDF", async () => {
			const pdf = await PDFDocument.create();
			pdf.addPage();
			const bytes = await pdf.save();
			await expect(
				openPapfContainer(new Blob([bytes as Uint8Array<ArrayBuffer>])),
			).rejects.toSatisfy(
				(e) => isPaplicoError(e) && e.code === "PAPF_NOT_FOUND_IN_PDF",
			);
		});

		it("should reject a file that is neither papf nor PDF with PAPF_INVALID_FILE", async () => {
			await expect(
				openPapfContainer(new Blob(["hello world"])),
			).rejects.toSatisfy(
				(e) => isPaplicoError(e) && e.code === "PAPF_INVALID_FILE",
			);
		});
	});
});

function makeDoc(): Document {
	return {
		id: "pdf-container-doc",
		objects: {},
		layers: [],
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files: [],
		artboards: [
			{ id: "ab-1", name: "Artboard 1", x: 0, y: 0, width: 200, height: 100 },
		],
		brushPresets: [],
		units: "px",
	};
}

async function papfBytes(doc = makeDoc()): Promise<Uint8Array> {
	return new Uint8Array(await (await serializeDocument(doc)).arrayBuffer());
}

function makeJpeg(): Uint8Array {
	const canvas = createCanvas(4, 2);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ff0000";
	ctx.fillRect(0, 0, 4, 2);
	return new Uint8Array(canvas.toBuffer("image/jpeg"));
}
