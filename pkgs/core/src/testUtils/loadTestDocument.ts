import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareMigrationContext } from "../io/migrations/context";
import { openPapfContainer } from "../io/papf/pdfContainer";
import type { Document } from "../schema";
import { getTestFontManager } from "./fontSetup";

const TEST_DOCUMENT_PATH = resolve(__dirname, "fixtures/test-document.papf");

export async function loadTestDocument(): Promise<Document> {
	return loadPapfDocument(TEST_DOCUMENT_PATH);
}

/** Load any .papf file from an absolute path (for perf/visual tests that use
 *  documents other than the default test-document.papf). The file may be a
 *  raw papf or the PDF container the app saves. */
export async function loadPapfDocument(
	absolutePath: string,
): Promise<Document> {
	const buffer = readFileSync(absolutePath);
	const blob = new Blob([buffer]);
	const papf = await openPapfContainer(blob);
	return papf.toDocument(async (stored) =>
		prepareMigrationContext(stored, await getTestFontManager()),
	);
}
