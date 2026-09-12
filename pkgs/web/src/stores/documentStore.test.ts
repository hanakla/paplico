import { describe, expect, it } from "vitest";
import { db } from "@/infra/documentDB";
import {
	createDocument,
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
		expect(await loadDocumentData("doc-new")).not.toBeNull();
	});

	it("should update the existing record instead of adding a second one", async () => {
		const id = await createDocument("Original");
		await renameDocument(id, "Renamed by user");
		const before = await listDocumentMetas();

		await upsertDocument(id, "file-name", new Blob(["b"]));

		const after = await listDocumentMetas();
		expect(after.length).toBe(before.length);
		expect(after.find((m) => m.id === id)?.name).toBe("Renamed by user");
	});
});
