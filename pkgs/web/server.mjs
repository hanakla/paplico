/**
 * Next.js Custom Server with WebSocket support
 */

import fs from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { parse } from "node:url";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { setIfUndefined } from "lib0/map";
import next from "next";
import { WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const __dirname = import.meta.dirname;

// ---------------------------------------------------------------------------
// Yjs WebSocket server utilities (inlined from y-websocket v2 bin/utils)
// ---------------------------------------------------------------------------

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;
const pingTimeout = 30000;

const send = (doc, conn, m) => {
	if (
		conn.readyState !== wsReadyStateConnecting &&
		conn.readyState !== wsReadyStateOpen
	) {
		closeConn(doc, conn);
	}
	try {
		conn.send(m, (err) => {
			if (err != null) closeConn(doc, conn);
		});
	} catch (_e) {
		closeConn(doc, conn);
	}
};

const closeConn = (doc, conn) => {
	if (doc.conns.has(conn)) {
		const controlledIds = doc.conns.get(conn);
		doc.conns.delete(conn);
		awarenessProtocol.removeAwarenessStates(
			doc.awareness,
			Array.from(controlledIds),
			null,
		);
		if (doc.conns.size === 0) {
			doc.destroy();
			docs.delete(doc.name);
		}
	}
	conn.close();
};

const messageListener = (conn, doc, message) => {
	try {
		const encoder = encoding.createEncoder();
		const decoder = decoding.createDecoder(message);
		const messageType = decoding.readVarUint(decoder);
		switch (messageType) {
			case messageSync:
				encoding.writeVarUint(encoder, messageSync);
				syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
				if (encoding.length(encoder) > 1) {
					send(doc, conn, encoding.toUint8Array(encoder));
				}
				break;
			case messageAwareness:
				awarenessProtocol.applyAwarenessUpdate(
					doc.awareness,
					decoding.readVarUint8Array(decoder),
					conn,
				);
				break;
		}
	} catch (err) {
		console.error(err);
		doc.emit("error", [err]);
	}
};

class WSSharedDoc extends Y.Doc {
	constructor(name) {
		super({ gc: true });
		this.name = name;
		this.conns = new Map();
		this.awareness = new awarenessProtocol.Awareness(this);
		this.awareness.setLocalState(null);

		const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
			const changedClients = added.concat(updated, removed);
			const connControlledIDs = this.conns.get(conn);
			if (connControlledIDs !== undefined) {
				for (const clientID of added) connControlledIDs.add(clientID);
				for (const clientID of removed) connControlledIDs.delete(clientID);
			}
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
			);
			const buff = encoding.toUint8Array(encoder);
			this.conns.forEach((_, c) => {
				send(this, c, buff);
			});
		};

		this.awareness.on("update", awarenessChangeHandler);
		this.on("update", (update, _origin) => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			syncProtocol.writeUpdate(encoder, update);
			const message = encoding.toUint8Array(encoder);
			this.conns.forEach((_, conn) => {
				send(this, conn, message);
			});
		});
	}
}

const setupWSConnection = (
	conn,
	req,
	{ docName = (req.url ?? "").slice(1).split("?")[0], gc = true } = {},
) => {
	conn.binaryType = "arraybuffer";
	const doc = setIfUndefined(docs, docName, () => {
		const d = new WSSharedDoc(docName);
		d.gc = gc;
		return d;
	});
	doc.conns.set(conn, new Set());

	conn.on("message", (message) =>
		messageListener(conn, doc, new Uint8Array(message)),
	);

	let pongReceived = true;
	const pingInterval = setInterval(() => {
		if (!pongReceived) {
			if (doc.conns.has(conn)) closeConn(doc, conn);
			clearInterval(pingInterval);
		} else if (doc.conns.has(conn)) {
			pongReceived = false;
			try {
				conn.ping();
			} catch (_e) {
				closeConn(doc, conn);
				clearInterval(pingInterval);
			}
		}
	}, pingTimeout);

	conn.on("close", () => {
		closeConn(doc, conn);
		clearInterval(pingInterval);
	});
	conn.on("pong", () => {
		pongReceived = true;
	});

	{
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, messageSync);
		syncProtocol.writeSyncStep1(encoder, doc);
		send(doc, conn, encoding.toUint8Array(encoder));
		const awarenessStates = doc.awareness.getStates();
		if (awarenessStates.size > 0) {
			const enc = encoding.createEncoder();
			encoding.writeVarUint(enc, messageAwareness);
			encoding.writeVarUint8Array(
				enc,
				awarenessProtocol.encodeAwarenessUpdate(
					doc.awareness,
					Array.from(awarenessStates.keys()),
				),
			);
			send(doc, conn, encoding.toUint8Array(enc));
		}
	}
};

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

const CollabMessage = {
	Custom: 3,
	Kick: 1,
	Kicked: 2,
	CloseRoom: 3,
	RoomClosed: 4,
};

// roomId → { ownerConn, ownerId }
const roomMeta = new Map();

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";

// Parse command line arguments for port
const args = process.argv.slice(2);
const portIndex = args.indexOf("-p");
const port =
	portIndex !== -1 && args[portIndex + 1]
		? Number.parseInt(args[portIndex + 1], 10)
		: 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const lockFilePath = path.join(__dirname, "../../pap.lock");

// Check if lock file exists and process is running
if (fs.existsSync(lockFilePath)) {
	try {
		const pidString = fs.readFileSync(lockFilePath, "utf8").trim();
		const pid = parseInt(pidString, 10);

		if (!Number.isNaN(pid)) {
			try {
				process.kill(pid, 0);
				console.error(
					`> Error: Server already running with PID ${pid}. Stop it first with: kill ${pid}`,
				);
				process.exit(1);
			} catch (_err) {
				console.log(`> Removing stale lock file (PID ${pid} not running)`);
				fs.unlinkSync(lockFilePath);
			}
		} else {
			console.log("> Removing invalid lock file");
			fs.unlinkSync(lockFilePath);
		}
	} catch (err) {
		console.error("> Error reading lock file:", err);
		process.exit(1);
	}
}

app.prepare().then(() => {
	const httpsOptions = {
		key: fs.readFileSync(
			path.join(__dirname, "../../.certs", "localhost-key.pem"),
		),
		cert: fs.readFileSync(
			path.join(__dirname, "../../.certs", "localhost-cert.pem"),
		),
	};

	const server = createServer(httpsOptions, async (req, res) => {
		try {
			const parsedUrl = parse(req.url, true);

			// Room metadata API: GET /api/collaboration/{roomId}/meta
			const metaMatch = parsedUrl.pathname?.match(
				/^\/api\/collaboration\/([^/]+)\/meta$/,
			);
			if (metaMatch && req.method === "GET") {
				const roomId = metaMatch[1];
				const doc = docs.get(roomId);
				res.setHeader("Content-Type", "application/json");
				if (!doc) {
					res.statusCode = 404;
					res.end(JSON.stringify({ error: "room not found" }));
					return;
				}
				const yMeta = doc.getMap("meta");
				const meta = {};
				yMeta.forEach((value, key) => {
					meta[key] = value;
				});
				res.end(JSON.stringify(meta));
				return;
			}

			await handle(req, res, parsedUrl);
		} catch (err) {
			console.error("Error occurred handling", req.url, err);
			res.statusCode = 500;
			res.end("internal server error");
		}
	});

	const wss = new WebSocketServer({ noServer: true });
	const upgradeHandler = app.getUpgradeHandler();

	server.on("upgrade", (request, socket, head) => {
		const { pathname } = parse(request.url, true);
		if (pathname.startsWith("/api/collaboration")) {
			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit("connection", ws, request);
			});
		} else {
			// Delegate other upgrades (e.g. Next.js HMR /_next/webpack-hmr) to Next.js
			upgradeHandler(request, socket, head);
		}
	});

	wss.on("connection", (ws, req) => {
		const { pathname, query } = parse(req.url, true);
		const pathMatch = pathname.match(/\/api\/collaboration\/([^?]+)/);
		const roomId = pathMatch?.[1] ? pathMatch[1] : "default-room";
		const isOwnerParam = query.owner === "1";
		const ownerId = query.ownerId;

		if (isOwnerParam && query.roomReadonly === "1") {
			const meta = roomMeta.get(roomId);
			if (meta) {
				meta.readonly = true;
			} else {
				roomMeta.set(roomId, { ownerConn: ws, ownerId, readonly: true });
			}
		}

		const roomReadonly = roomMeta.get(roomId)?.readonly ?? false;
		const isOwner =
			isOwnerParam || (ownerId && ownerId === roomMeta.get(roomId)?.ownerId);
		const isReadonly = !isOwner && roomReadonly;

		console.log(
			`Client connecting to room: ${roomId}${isReadonly ? " (readonly)" : ""}${isOwnerParam ? " (owner)" : ""}`,
		);

		const isNewRoom = !docs.has(roomId);

		// Readonly enforcement: proxy ws.on to intercept and drop write messages
		if (isReadonly) {
			const originalOn = ws.on.bind(ws);
			ws.on = (event, listener) => {
				if (event === "message") {
					originalOn(event, (message) => {
						const data = new Uint8Array(message);
						if (data.length < 2) {
							listener(message);
							return;
						}
						const decoder = decoding.createDecoder(data);
						const msgType = decoding.readVarUint(decoder);
						if (msgType === 0 /* messageSync */) {
							const syncType = decoding.readVarUint(decoder);
							// Drop SyncStep2 (1) and Update (2) from readonly clients
							if (syncType === 1 || syncType === 2) return;
						}
						listener(message);
					});
				} else {
					originalOn(event, listener);
				}
			};
		}

		setupWSConnection(ws, req, { docName: roomId, gc: true });

		// Owner registration
		if (isOwnerParam && ownerId) {
			const existing = roomMeta.get(roomId);
			if (!existing) {
				roomMeta.set(roomId, {
					ownerConn: ws,
					ownerId,
					readonly: query.roomReadonly === "1",
				});
			} else if (existing.ownerId === ownerId) {
				existing.ownerConn = ws;
			}
		}

		// Initialize the Y.Doc with a default layer only for new rooms
		if (isNewRoom) {
			const doc = docs.get(roomId);
			if (doc) {
				const yLayers = doc.getArray("layers");

				if (yLayers.length === 0) {
					console.log(`📝 Initializing new room: ${roomId}`);

					const yLayer = new Y.Map();
					const layerId = `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
					yLayer.set("id", layerId);
					yLayer.set("name", "Layer 1");
					yLayer.set("visible", true);
					yLayer.set("locked", false);
					yLayer.set("opacity", 1);
					yLayer.set("elementIds", new Y.Array());

					yLayers.push([yLayer]);

					const yMeta = doc.getMap("meta");
					yMeta.set("id", `doc-${Date.now()}`);
					yMeta.set("name", "Untitled Document");

					if (ownerId) {
						yMeta.set("ownerId", ownerId);
					}

					console.log(`✅ Room ${roomId} initialized with default layer`);
				}
			}
		}

		// Handle custom messages (kick, closeRoom) from owner
		ws.on("message", (message) => {
			const data = new Uint8Array(message);
			if (data.length < 2) return;

			const decoder = decoding.createDecoder(data);
			const msgType = decoding.readVarUint(decoder);
			if (msgType !== CollabMessage.Custom) return;

			const meta = roomMeta.get(roomId);
			if (!meta || meta.ownerConn !== ws) return;

			const subType = decoding.readVarUint(decoder);
			const doc = docs.get(roomId);
			if (!doc) return;

			if (subType === CollabMessage.Kick) {
				const targetClientId = decoding.readVarUint(decoder);
				doc.conns.forEach((controlledIds, conn) => {
					if (controlledIds.has(targetClientId)) {
						const enc = encoding.createEncoder();
						encoding.writeVarUint(enc, CollabMessage.Custom);
						encoding.writeVarUint(enc, CollabMessage.Kicked);
						const msg = encoding.toUint8Array(enc);
						try {
							conn.send(msg);
						} catch {}
						setTimeout(() => {
							try {
								conn.close();
							} catch {}
						}, 100);
					}
				});
			} else if (subType === CollabMessage.CloseRoom) {
				doc.conns.forEach((_, conn) => {
					if (conn === ws) return;
					const enc = encoding.createEncoder();
					encoding.writeVarUint(enc, CollabMessage.Custom);
					encoding.writeVarUint(enc, CollabMessage.RoomClosed);
					const msg = encoding.toUint8Array(enc);
					try {
						conn.send(msg);
					} catch {}
					setTimeout(() => {
						try {
							conn.close();
						} catch {}
					}, 100);
				});
				roomMeta.delete(roomId);
			}
		});

		console.log(`Client connected to room ${roomId}`);

		ws.on("close", () => {
			console.log(`Client disconnected from room ${roomId}`);
			const meta = roomMeta.get(roomId);
			if (meta?.ownerConn === ws) {
				meta.ownerConn = null;
			}
		});

		ws.on("error", (error) => {
			console.error(`❌ WebSocket error in room ${roomId}:`, error);
		});
	});

	server.listen(port, () => {
		console.log(`> Ready on https://${hostname}:${port}`);
		console.log(
			`> WebSocket server ready on wss://${hostname}:${port}/api/collaboration`,
		);

		fs.writeFileSync(lockFilePath, `${process.pid}\n`, "utf8");
		console.log(`> PID ${process.pid} written to pap.lock`);
	});

	process.on("SIGINT", () => {
		const lockFilePath = path.join(__dirname, "../../pap.lock");
		if (fs.existsSync(lockFilePath)) {
			fs.unlinkSync(lockFilePath);
			console.log("\n> Lock file removed");
		}
		process.exit(0);
	});
});
