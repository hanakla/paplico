import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
	DocumentData,
	DocumentMeta,
	DocumentRevision,
	DocumentSnapshot,
	DocumentsRepo,
} from "@/infra/documentDB.types";

/**
 * Documents and thumbnails cross IPC as raw bytes in an envelope: a
 * little-endian u32 header length, a JSON header, then the bytes that the
 * header's BlobRefs point into. The Rust side is src-tauri/src/documents.rs.
 */
type BlobRef = { offset: number; length: number };

type SnapshotRefs = { document: BlobRef; thumbnail: BlobRef | null };

type WithBlobRefs<T> = {
	[K in keyof T]: T[K] extends Blob
		? BlobRef
		: T[K] extends Blob | null
			? BlobRef | null
			: T[K];
};

export const tauriDocumentsRepo: DocumentsRepo = {
	async listMetas() {
		const envelope = await invokeEnvelope<WithBlobRefs<DocumentMeta>[]>(
			"documents_list_metas",
		);
		return envelope.header.map((meta) => readMeta(envelope, meta));
	},

	async getMeta(id) {
		const envelope = await invokeEnvelope<WithBlobRefs<DocumentMeta> | null>(
			"documents_get_meta",
			{ id },
		);
		return envelope.header && readMeta(envelope, envelope.header);
	},

	async load(id) {
		const envelope = await invokeEnvelope<WithBlobRefs<DocumentData> | null>(
			"documents_load",
			{ id },
		);
		return envelope.header && readSnapshot(envelope, envelope.header);
	},

	async listRevisions(documentId) {
		const envelope = await invokeEnvelope<WithBlobRefs<DocumentRevision>[]>(
			"documents_list_revisions",
			{ documentId },
		);
		return envelope.header.map((revision) => readSnapshot(envelope, revision));
	},

	async countRevisions() {
		return invoke<Record<string, number>>("documents_count_revisions");
	},

	async create(meta, data) {
		const envelope = new EnvelopeWriter();
		await invoke(
			"documents_create",
			await envelope.finish({
				meta: { ...meta, thumbnail: envelope.attach(meta.thumbnail) },
				data: {
					document: envelope.attach(data.document),
					thumbnail: envelope.attach(data.thumbnail),
					createdAt: data.createdAt,
				},
			}),
		);
	},

	async upsert(id, name, document, now) {
		const envelope = new EnvelopeWriter();
		await invoke(
			"documents_upsert",
			await envelope.finish({
				id,
				name,
				now,
				document: envelope.attach(document),
			}),
		);
	},

	async save(id, document, thumbnail, now) {
		const envelope = new EnvelopeWriter();
		await invoke(
			"documents_save",
			await envelope.finish({
				id,
				now,
				document: envelope.attach(document),
				thumbnail: envelope.attach(thumbnail ?? null),
				replaceMetaThumbnail: thumbnail !== undefined,
			}),
		);
	},

	async addRevision(revision, keepCount) {
		const envelope = new EnvelopeWriter();
		await invoke(
			"documents_add_revision",
			await envelope.finish({
				...revision,
				document: envelope.attach(revision.document),
				thumbnail: envelope.attach(revision.thumbnail),
				keepCount,
			}),
		);
	},

	async delete(id) {
		await invoke("documents_delete", { id });
	},

	async rename(id, name) {
		await invoke("documents_rename", { id, name });
	},
};

class EnvelopeWriter {
	private parts: Blob[] = [];
	private size = 0;

	public attach(blob: Blob): BlobRef;
	public attach(blob: Blob | null): BlobRef | null;
	public attach(blob: Blob | null): BlobRef | null {
		if (!blob) return null;
		const ref = { offset: this.size, length: blob.size };
		this.parts.push(blob);
		this.size += blob.size;
		return ref;
	}

	public async finish(header: unknown): Promise<Uint8Array> {
		const headerBytes = new TextEncoder().encode(JSON.stringify(header));
		const headerLength = new Uint8Array(4);
		new DataView(headerLength.buffer).setUint32(0, headerBytes.length, true);
		return new Uint8Array(
			await new Blob([headerLength, headerBytes, ...this.parts]).arrayBuffer(),
		);
	}
}

class EnvelopeReader<T> {
	public readonly header: T;
	private readonly blobsOffset: number;

	public constructor(private readonly buffer: ArrayBuffer) {
		const headerLength = new DataView(buffer).getUint32(0, true);
		this.header = JSON.parse(
			new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
		);
		this.blobsOffset = 4 + headerLength;
	}

	public blob(ref: BlobRef): Blob;
	public blob(ref: BlobRef | null): Blob | null;
	public blob(ref: BlobRef | null): Blob | null {
		if (!ref) return null;
		return new Blob([
			new Uint8Array(this.buffer, this.blobsOffset + ref.offset, ref.length),
		]);
	}
}

async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(command, args);
}

async function invokeEnvelope<T>(
	command: string,
	args?: InvokeArgs,
): Promise<EnvelopeReader<T>> {
	const body = await invoke<ArrayBuffer | number[]>(command, args);
	// The postMessage IPC, which Tauri falls back to when the webview blocks
	// the custom protocol, returns the bytes as a number array.
	return new EnvelopeReader<T>(
		Array.isArray(body) ? new Uint8Array(body).buffer : body,
	);
}

function readMeta(
	envelope: EnvelopeReader<unknown>,
	meta: WithBlobRefs<DocumentMeta>,
): DocumentMeta {
	return { ...meta, thumbnail: envelope.blob(meta.thumbnail) };
}

function readSnapshot<T extends SnapshotRefs>(
	envelope: EnvelopeReader<unknown>,
	snapshot: T,
): Omit<T, keyof SnapshotRefs> & Pick<DocumentSnapshot, keyof SnapshotRefs> {
	return {
		...snapshot,
		document: envelope.blob(snapshot.document),
		thumbnail: envelope.blob(snapshot.thumbnail),
	};
}
