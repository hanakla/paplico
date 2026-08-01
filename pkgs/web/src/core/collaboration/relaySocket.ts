/**
 * Transport to the relay party.
 *
 * The relay forwards opaque payloads and never holds a key, so everything that
 * gives a message meaning — what it is, who it came from — has to be carried
 * inside the encrypted body by whoever is speaking. This module only moves
 * bytes.
 */

import PartySocket from "partysocket";

/**
 * The relay announces a departure in the clear, because it holds no key to
 * encrypt with. All it can say is which connection went away; whose it was,
 * and whether that matters, is for the caller to work out.
 */
const PEER_LEFT_PREFIX = "left:";

/** Transport seam so tests can drive a protocol without a real relay. */
export type RelaySocket = {
	/** Identifies this connection to the relay, and to peers through it. */
	readonly id: string;
	send(data: Uint8Array): void;
	close(): void;
	reconnect(): void;
	onMessage(handler: (data: Uint8Array) => void): void;
	/** Called with the connection id of a peer the relay saw leave. */
	onPeerLeft(handler: (connectionId: string) => void): void;
	onStatusChange(handler: (status: "connected" | "disconnected") => void): void;
};

export function createPartyRelaySocket(roomId: string): RelaySocket {
	const socket = new PartySocket({
		host: resolveRelayHost(),
		party: "relay",
		room: roomId,
		// Follow the page: a plain ws:// from an https:// page is blocked as
		// mixed content, and the dev relay is served over TLS for that reason.
		protocol: globalThis.location?.protocol === "https:" ? "wss" : "ws",
	});
	socket.binaryType = "arraybuffer";

	return {
		get id() {
			return socket.id;
		},
		send: (data) => socket.send(data),
		close: () => socket.close(),
		reconnect: () => socket.reconnect(),
		onMessage: (handler) => {
			socket.addEventListener("message", (event) => {
				if (event.data instanceof ArrayBuffer)
					handler(new Uint8Array(event.data));
			});
		},
		onPeerLeft: (handler) => {
			// Peers only ever send binary, so a string can only be the relay
			// speaking for itself.
			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				if (!event.data.startsWith(PEER_LEFT_PREFIX)) return;
				handler(event.data.slice(PEER_LEFT_PREFIX.length));
			});
		},
		onStatusChange: (handler) => {
			socket.addEventListener("open", () => handler("connected"));
			socket.addEventListener("close", () => handler("disconnected"));
		},
	};
}

const LOCALHOST_PATTERN =
	/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(\d+))?\/?$/;

/**
 * Where the relay is.
 *
 * A host configured as localhost is only right for the machine that built the
 * page. Any other device reached this page over the network, and the relay is
 * served beside it — so follow the address the page actually came from. A
 * configured host that names a real machine is left alone.
 */
function resolveRelayHost(): string {
	const configured = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";

	const local = LOCALHOST_PATTERN.exec(configured);
	if (!local) return configured;

	const hostname = globalThis.location?.hostname;
	if (!hostname || LOCALHOST_PATTERN.test(hostname)) return configured;

	return `${hostname}:${local[1] ?? "1999"}`;
}
