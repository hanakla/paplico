import type * as Y from "yjs";
import type { ICollaboration } from "./ICollaboration";
import type { YjsProvider } from "./YjsProvider";

/**
 * What happens to the local document when a transport attaches.
 * `"fromRemote"` discards it so the room's state is adopted as-is.
 * `"keepForRemote"` keeps it and merges it with the room's state.
 */
export type CollaborationDocumentMode = "fromRemote" | "keepForRemote";

/**
 * Build a transport around the provider's Y.Doc after preparing the local
 * document for the room, so no caller can build it on a Y.Doc that is about
 * to be replaced.
 */
export function attachCollaboration<T extends ICollaboration>(
	provider: YjsProvider,
	factory: (ydoc: Y.Doc) => T,
	document: CollaborationDocumentMode,
): T {
	if (document === "fromRemote") {
		provider.resetWithFreshDoc();
	}

	const collab = factory(provider.ydoc);
	if (document === "keepForRemote") {
		// Y.Array keeps both sides' entries on merge, so a layer present
		// locally and in the room ends up listed twice.
		const handleSynced = (isSynced: boolean) => {
			if (!isSynced) return;
			provider.deduplicateLayers();
			collab.off("synced", handleSynced);
		};
		collab.on("synced", handleSynced);
	}

	return collab;
}
