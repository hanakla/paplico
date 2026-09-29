import type * as Y from "yjs";
import type { MigrationContext } from "../io/migrations/context";
import type { Document } from "../schema";
import type { ICollaboration } from "./ICollaboration";
import type { YjsProvider } from "./YjsProvider";

/**
 * What happens to the local document when a transport attaches.
 * `"fromRemote"` discards it so the room's state is adopted as-is.
 * `"keepForRemote"` keeps it and merges it with the room's state.
 */
export type CollaborationDocumentMode = "fromRemote" | "keepForRemote";

export interface AttachCollaborationOptions {
	/**
	 * Measures for the room migration what it cannot read off the document
	 * (see prepareMigrationContext).
	 */
	prepareMigrationContext?: (doc: Document) => Promise<MigrationContext>;
	/**
	 * Aborted when the connection is dropped, so a room migration still
	 * measuring is abandoned instead of rewriting whatever document the
	 * provider holds by then.
	 */
	signal?: AbortSignal;
	/** The room was written by a newer client, so it was left as it is. */
	onRoomSchemaNewer?: () => void;
	/** The room has synced and its document is ready to be shown. */
	onReady?: () => void;
}

/**
 * Build a transport around the provider's Y.Doc after preparing the local
 * document for the room, so no caller can build it on a Y.Doc that is about
 * to be replaced. Once the room has synced, its document is brought up to
 * this client's schema before `onReady` reports it.
 *
 * A local document kept for the room is at this client's schema while the
 * room may be at an older one. Without the local version stamp the merged
 * document carries the room's, and the local objects are kept out of the
 * room migration, so each side is read at the schema it was written in.
 */
export function attachCollaboration<T extends ICollaboration>(
	provider: YjsProvider,
	factory: (ydoc: Y.Doc) => T,
	document: CollaborationDocumentMode,
	options: AttachCollaborationOptions = {},
): T {
	const localObjectIds = new Set<string>();
	if (document === "fromRemote") {
		provider.resetWithFreshDoc();
	} else {
		for (const id of provider.getObjectIds()) localObjectIds.add(id);
		provider.clearSchemaVersion();
	}

	const collab = factory(provider.ydoc);
	const handleSynced = (isSynced: boolean) => {
		if (!isSynced) return;
		collab.off("synced", handleSynced);
		if (document === "keepForRemote") {
			// Y.Array keeps both sides' entries on merge, so a layer present
			// locally and in the room ends up listed twice.
			provider.deduplicateLayers();
		}
		void provider
			.migrateRoomSchema(
				options.prepareMigrationContext,
				localObjectIds,
				options.signal,
			)
			.then((state) => {
				if (state === "abandoned") return;
				if (state === "newer") options.onRoomSchemaNewer?.();
				options.onReady?.();
			});
	};
	collab.on("synced", handleSynced);

	return collab;
}
