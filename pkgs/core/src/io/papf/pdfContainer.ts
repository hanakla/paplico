/**
 * PDF container for papf documents.
 *
 * A saved document is a valid PDF that any viewer opens: one page per
 * artboard carrying a raster preview. The full papf byte stream sits
 * untouched in the catalog's `/PieceInfo /Paplico /Private` stream, the
 * mechanism ISO 32000 14.5 defines for application-private data, so Paplico
 * reads it back from the same file.
 */

import {
	decodePDFRawStream,
	ParseSpeeds,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFRawStream,
	PDFStream,
	PDFString,
} from "@cantoo/pdf-lib";
import { PaplicoError } from "../../errors";
import { openPapf, type PapfFile } from "./reader";
import { MAGIC_HEADER } from "./types";

export interface PdfPreviewPage {
	/** Page width in PDF points (= papf world units) */
	width: number;
	/** Page height in PDF points (= papf world units) */
	height: number;
	/** JPEG preview drawn over the whole page, or null for a blank page */
	jpeg: Uint8Array | null;
}

const PDF_MAGIC = new TextEncoder().encode("%PDF-");
const PIECE_INFO = PDFName.of("PieceInfo");
const PAPLICO = PDFName.of("Paplico");
const PRIVATE = PDFName.of("Private");

/** Wraps a papf byte stream into a PDF with one preview page per artboard. */
export async function wrapPapfInPdf(
	papf: Uint8Array,
	pages: PdfPreviewPage[],
): Promise<Blob> {
	const pdf = await PDFDocument.create();
	pdf.setProducer("Paplico");
	pdf.setCreator("Paplico");

	for (const { width, height, jpeg } of pages) {
		const page = pdf.addPage([width, height]);
		if (!jpeg) continue;
		const image = await pdf.embedJpg(jpeg);
		page.drawImage(image, { x: 0, y: 0, width, height });
	}
	// A PDF must have at least one page.
	if (pages.length === 0) pdf.addPage();

	const privateRef = pdf.context.register(pdf.context.stream(papf));
	pdf.catalog.set(
		PIECE_INFO,
		pdf.context.obj({
			Paplico: {
				LastModified: PDFString.fromDate(new Date()),
				Private: privateRef,
			},
		}),
	);

	// Object streams would relocate and compress the papf stream.
	const bytes = await pdf.save({ useObjectStreams: false });
	return new Blob([bytes as Uint8Array<ArrayBuffer>], {
		type: "application/pdf",
	});
}

/** Opens a document saved either as a raw papf or as a PDF container. */
export async function openPapfContainer(source: Blob): Promise<PapfFile> {
	const head = new Uint8Array(
		await source.slice(0, PDF_MAGIC.length).arrayBuffer(),
	);
	if (startsWith(head, MAGIC_HEADER)) return openPapf(source);
	if (!startsWith(head, PDF_MAGIC)) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			"PAPF: file is neither a papf nor a PDF",
		);
	}
	const papf = await extractPapfFromPdf(source);
	return openPapf(new Blob([papf as Uint8Array<ArrayBuffer>]));
}

async function extractPapfFromPdf(source: Blob): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(await source.arrayBuffer(), {
		ignoreEncryption: true,
		updateMetadata: false,
		parseSpeed: ParseSpeeds.Fastest,
	});
	const stream = pdf.catalog
		.lookupMaybe(PIECE_INFO, PDFDict)
		?.lookupMaybe(PAPLICO, PDFDict)
		?.lookupMaybe(PRIVATE, PDFStream);
	if (!(stream instanceof PDFRawStream)) {
		throw new PaplicoError(
			"PAPF_NOT_FOUND_IN_PDF",
			"PAPF: PDF carries no Paplico data (re-saved by another app?)",
		);
	}
	// Another app re-saving the PDF may have applied a filter to the stream.
	return stream.dict.has(PDFName.of("Filter"))
		? decodePDFRawStream(stream).decode()
		: stream.contents;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
	return prefix.every((byte, i) => data[i] === byte);
}
