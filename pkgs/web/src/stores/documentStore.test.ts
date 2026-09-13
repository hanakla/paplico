// @vitest-environment node
// Blobs only survive fake-indexeddb's structured clone as Node Blobs.
import { describe, expect, it } from "vitest";
import { openPapf } from "@/core/io/papf/reader";
import { db } from "@/infra/documentDB";
import {
	createDocument,
	duplicateDocument,
	listDocumentMetas,
	loadDocumentData,
	renameDocument,
	upsertDocument,
} from "./documentStore";

describe("upsertDocument", () => {
	it("should create a record under the given id when none exists", async () => {
		await upsertDocument("doc-new", "From file", new Blob(["a"]));

		const meta = await db.documentMeta.get("doc-new");
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
