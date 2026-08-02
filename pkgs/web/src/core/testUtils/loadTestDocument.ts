import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openPapf } from "../io/papf/reader";
import type { Document } from "../schema";

const TEST_DOCUMENT_PATH = resolve(__dirname, "../../tests/test-document.papf");

export async function loadTestDocument(): Promise<Document> {
	const buffer = readFileSync(TEST_DOCUMENT_PATH);
	const blob = new Blob([buffer]);
	const papf = await openPapf(blob);
	return papf.toDocument();
}
