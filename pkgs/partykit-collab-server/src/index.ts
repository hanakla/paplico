/**
 * Worker entry for Paplico collaboration (cloud mode).
 *
 * Routes /parties/main/:room to the document server and /parties/relay/:room
 * to the end-to-end encrypted relay. Only the document server authenticates
 * at the edge; the relay is gated by the room key its clients hold.
 */

import { routePartykitRequest } from "partyserver";
import { DocumentServer } from "./document";

export { DocumentServer } from "./document";
export { RelayServer } from "./relay";

export default {
	async fetch(request, env) {
		return (
			(await routePartykitRequest(request, env, {
				onBeforeConnect: (req, lobby) =>
					lobby.className === "Main"
						? DocumentServer.onBeforeConnect(req, lobby.name, env)
						: undefined,
			})) ?? new Response("Not Found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;
