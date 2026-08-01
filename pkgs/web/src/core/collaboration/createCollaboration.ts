/**
 * Factory function to create the appropriate Collaboration instance.
 *
 * A room key takes precedence over the mode: it means the session is end-to-end
 * encrypted, which only the relay-based provider can serve. Otherwise the
 * NEXT_PUBLIC_COLLAB_MODE environment variable decides.
 *
 * - room key present: Uses partysocket → relay party (server sees only ciphertext)
 * - "local" (default): Uses y-websocket → server.js (no external services)
 * - "cloud": Uses y-partykit → PartyKit (requires Clerk + PartyKit setup)
 */

import { Collaboration } from "./Collaboration";
import { E2EECollaboration } from "./E2EECollaboration";
import type { CollaborationConfig, ICollaboration } from "./ICollaboration";
import { PartyKitCollaboration } from "./PartyKitCollaboration";
import type { YjsProvider } from "./YjsProvider";

export function createCollaboration(
	provider: YjsProvider,
	config: CollaborationConfig,
	options?: { isReconnect?: boolean },
): ICollaboration {
	const ydoc = provider.ydoc;
	const collab: ICollaboration = config.roomKey
		? new E2EECollaboration(ydoc, config)
		: process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud"
			? new PartyKitCollaboration(ydoc, config)
			: new Collaboration(ydoc, config);

	if (options?.isReconnect) {
		const handler = (isSynced: boolean) => {
			if (!isSynced) return;
			provider.deduplicateLayers();
			collab.off("synced", handler);
		};

		collab.on("synced", handler);
	}

	return collab;
}
