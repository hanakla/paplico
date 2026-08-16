import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openPapf } from "../io/papf/reader";
import type { Document } from "../schema";

const TEST_DOCUMENT_PATH = resolve(__dirname, "../../tests/test-document.papf");

export async function loadTestDocument(): Promise<Document> {
	return loadPapfDocument(TEST_DOCUMENT_PATH);
}

/** Load any .papf file from an absolute path (for perf/visual tests that use
 *  documents other than the default test-document.papf). */
export async function loadPapfDocument(
	absolutePath: string,
): Promise<Document> {
	const buffer = readFileSync(absolutePath);
	const blob = new Blob([buffer]);
	const papf = await openPapf(blob);
	return papf.toDocument();
}
