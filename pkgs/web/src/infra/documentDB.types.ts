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

/** Storage for the documents the app keeps for itself. */
export interface DocumentsRepo {
	/** Newest update first. */
	listMetas(): Promise<DocumentMeta[]>;
	getMeta(id: string): Promise<DocumentMeta | null>;
	load(id: string): Promise<DocumentData | null>;
	/** Newest first. */
	listRevisions(documentId: string): Promise<DocumentRevision[]>;
	countRevisions(): Promise<Record<string, number>>;
	create(meta: DocumentMeta, data: DocumentData): Promise<void>;
	/**
	 * Stores the content under `id`. An existing record keeps its name,
	 * creation time and list thumbnail.
	 */
	upsert(id: string, name: string, document: Blob, now: number): Promise<void>;
	/** An `undefined` thumbnail leaves the list thumbnail as it is. */
	save(
		id: string,
		document: Blob,
		thumbnail: Blob | null | undefined,
		now: number,
	): Promise<void>;
	/**
	 * Makes the revision the document's current content and keeps only the
	 * newest `keepCount` revisions of that document.
	 */
	addRevision(revision: DocumentRevision, keepCount: number): Promise<void>;
	delete(id: string): Promise<void>;
	rename(id: string, name: string): Promise<void>;
}
