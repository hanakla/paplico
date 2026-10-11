// @vitest-environment node
// Blobs only survive fake-indexeddb's structured clone as Node Blobs.

import { openPapf } from "@paplico/core/io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_SAVE_MAX_REVISIONS } from "@/configs";
import {
	createDocument,
	duplicateDocument,
	listDocumentMetas,
	listDocumentRevisions,
	loadDocumentData,
	loadDocumentMeta,
	renameDocument,
	saveRevision,
	upsertDocument,
} from "./documentStore";

describe("upsertDocument", () => {
	it("should create a record under the given id when none exists", async () => {
		await upsertDocument("doc-new", "From file", new Blob(["a"]));

		const meta = await loadDocumentMeta("doc-new");
		expect(meta?.name).toBe("From file");
		expect(await (await loadDocumentData("doc-new"))?.document.text()).toBe(
			"a",
		);
	});

	it("should update the existing record instead of adding a second one", async () => {
		const id = await createDocument("Original");
		await renameDocument(id, "Renamed by user");
		const before = await listDocumentMetas();

		await upsertDocument(id, "file-name", new Blob(["b"]));

		const after = await listDocumentMetas();
		expect(after.length).toBe(before.length);
		expect(after.find((m) => m.id === id)?.name).toBe("Renamed by user");
		expect(await (await loadDocumentData(id))?.document.text()).toBe("b");
	});
});

describe("duplicateDocument", () => {
	it("should give the copy its own id inside the document", async () => {
		const id = await createDocument("Original");

		const copyId = await duplicateDocument(id, "Original (copy)");

		const data = await loadDocumentData(copyId);
		if (!data) throw new Error("copy not stored");
		const copy = await (await openPapf(data.document)).toDocument();
		expect(copyId).not.toBe(id);
		expect(copy.id).toBe(copyId);
	});
});

describe("saveRevision", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("should keep only the newest revisions up to the limit", async () => {
		// Distinct timestamps keep the revisions in a stable order.
		vi.useFakeTimers({ toFake: ["Date"] });
		const id = await createDocument("History");

		for (let i = 0; i <= AUTO_SAVE_MAX_REVISIONS; i++) {
			vi.setSystemTime(1_000 + i);
			await saveRevision(id, new Blob([String(i)]), null);
		}

		const revisions = await listDocumentRevisions(id);
		const contents = await Promise.all(
			revisions.map((rev) => rev.document.text()),
		);
		expect(contents.length).toBe(AUTO_SAVE_MAX_REVISIONS);
		expect(contents.at(0)).toBe(String(AUTO_SAVE_MAX_REVISIONS));
		expect(contents).not.toContain("0");
	});
});
