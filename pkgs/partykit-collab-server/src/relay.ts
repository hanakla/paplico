/**
 * Relay party for end-to-end encrypted collaboration sessions.
 *
 * Unlike the document party, this one never materializes the Y.Doc and never
 * persists anything. Clients exchange payloads that only they can decrypt, so
 * there is nothing here to merge and nothing worth storing — once the last
 * participant leaves, no trace of the session remains.
 *
 * Participation is gated by knowing the room id and holding the room key, which
 * is why this party performs no authentication of its own.
 */

import { type Connection, Server, type WSMessage } from "partyserver";

/**
 * Departures are announced in the clear, because the relay has no key to
 * encrypt with. All it can say is which connection went away; whose it was,
 * and whether that matters, is for the clients to work out.
 *
 * Notices are strings and payloads are binary, so a client never has to
 * decide which of the two it is holding.
 */
const PEER_LEFT_PREFIX = "left:";

export class RelayServer extends Server {
	public onMessage(sender: Connection, message: WSMessage) {
		this.broadcast(message, [sender.id]);
	}

	public onClose(connection: Connection) {
		this.broadcast(`${PEER_LEFT_PREFIX}${connection.id}`, [connection.id]);
	}

	public onError(connection: Connection) {
		// A dropped connection leaves the same way a closed one does, and the
		// peers cannot tell the difference either.
		this.broadcast(`${PEER_LEFT_PREFIX}${connection.id}`, [connection.id]);
	}
}
