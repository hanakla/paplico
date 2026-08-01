import Dexie, { type EntityTable } from "dexie";

// --- Types ---

export interface DocumentMeta {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	thumbnail: Blob | null;
}

export interface DocumentSnapshot {
	/** PAPF serialized document (includes viewport) */
	document: Blob;
	thumbnail: Blob | null;
	createdAt: number;
}

export interface DocumentData extends DocumentSnapshot {
	/** Same as DocumentMeta.id (1:1 relationship) */
	id: string;
}

export interface DocumentRevision extends DocumentSnapshot {
	id: string;
	documentId: string;
}

// --- Database ---

class PaplicoDB extends Dexie {
	public documentMeta!: EntityTable<DocumentMeta, "id">;
	public documentData!: EntityTable<DocumentData, "id">;
	public documentRevisions!: EntityTable<DocumentRevision, "id">;

	public constructor() {
		super("paplico");
		this.version(1).stores({
			documentMeta: "id, updatedAt",
			documentData: "id",
		});
		this.version(2).stores({
			documentRevisions: "id, documentId, [documentId+createdAt]",
		});
	}
}

export const db = new PaplicoDB();
