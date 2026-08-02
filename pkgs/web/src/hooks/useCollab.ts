import { proxy, useSnapshot } from "valtio";
import { ConfirmDialog } from "@/components/AlertDialog";
import { toastManager } from "@/components/Toast";
import { createCollaboration } from "@/core/collaboration/createCollaboration";
import { buildInviteUrl } from "@/core/collaboration/inviteUrl";
import {
	exportRoomKey,
	generateRoomId,
	generateRoomKey,
	importRoomKey,
} from "@/core/collaboration/roomCrypto";
import type { Paplico } from "@/core/Paplico";
import { DisconnectedDialog } from "@/dialogs/DisconnectedDialog";
import { appConfig, setCollaborationUserName } from "@/hooks/useAppConfig";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales/index";
import { documentManagerState, saveDocument } from "@/stores/documentStore";
import { getReconnectInfo, setReconnectInfo } from "@/stores/sessionStore";
import { reportError } from "@/utils/errorReporting";
import { useEventCallback } from "@/utils/hooks";

interface CollabState {
	connectedRoomId: string | null;
	isRoomOwner: boolean;
	publishedRoomId: string | null;
	publishedReadonly: boolean;
	signInDialogOpen: boolean;
	pendingRoomId: string | null;
	/**
	 * Full invite URL. For an encrypted room it carries the key in its fragment,
	 * which makes it the only thing worth sharing — a room id on its own is
	 * useless without the key.
	 */
	inviteUrl: string | null;
	/**
	 * Whether the current room is end-to-end encrypted. Encrypted rooms live
	 * only on the relay for the length of the session: nothing is registered
	 * server-side, so there is no room API to call and nothing left behind.
	 */
	isEncryptedRoom: boolean;
	/**
	 * Joined, but the document has not arrived yet. Only encrypted sessions
	 * spend time here: a peer has to hand the document over, where a server
	 * that holds it answers immediately.
	 */
	isSyncing: boolean;
}

/**
 * Where an invite should point. The desktop build runs off tauri://localhost,
 * an origin that exists only inside that app — a link built from it opens
 * nowhere. The deployed site is the address a guest can actually reach, and
 * the desktop build is given it at build time.
 */
export function inviteOrigin(): string {
	return process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
}

/**
 * What the current encrypted session was opened with. A device already in one
 * can reach the companion channel with these, without anyone scanning a code
 * again — and since it already holds the document, reusing the key gives it
 * nothing it did not have.
 *
 * Kept outside `collabState` because a CryptoKey has no business in a Valtio
 * snapshot: it is not data to render, and copying it around only widens where
 * a secret lives.
 */
let encryptedRoomCredentials: {
	roomId: string;
	roomKey: CryptoKey;
} | null = null;

export function getEncryptedRoomCredentials(): {
	roomId: string;
	roomKey: CryptoKey;
} | null {
	return encryptedRoomCredentials;
}

const collabState = proxy<CollabState>({
	connectedRoomId: null,
	isRoomOwner: false,
	publishedRoomId: null,
	publishedReadonly: false,
	signInDialogOpen: false,
	pendingRoomId: null,
	inviteUrl: null,
	isEncryptedRoom: false,
	isSyncing: false,
});

export function useCollab(paplicoRef: React.RefObject<Paplico | null>) {
	const snap = useSnapshot(collabState);
	const session = useUserSession();
	const t = useTranslation();

	// Device-to-device sessions say "your devices", rooms say "room". Same
	// events underneath, but a user reaching their own iPad was never in a room.
	const setupCollaborationListeners = useEventCallback(
		(collab: ReturnType<typeof createCollaboration>, encrypted: boolean) => {
			let hasSynced = false;

			collab.on("synced", (isSynced) => {
				if (!isSynced) return;
				hasSynced = true;
				collabState.isSyncing = false;
				toastManager.add({
					title: encrypted
						? t("connectRoomDialog.deviceConnected")
						: t("connectRoomDialog.roomJoined"),
				});
			});

			collab.on("status", (status) => {
				if (!hasSynced) return;

				if (status === "disconnected") {
					toastManager.add({
						title: encrypted
							? t("connectRoomDialog.deviceDisconnected")
							: t("connectRoomDialog.roomDisconnected"),
						type: "warning",
						actionProps: {
							children: t("connectRoomDialog.reconnectAction"),
							onClick: () => collab.reconnect(),
						},
					});
				} else if (status === "connected") {
					toastManager.add({
						title: encrypted
							? t("connectRoomDialog.deviceReconnected")
							: t("connectRoomDialog.roomReconnected"),
						type: "info",
					});
				}
			});

			collab.on("kicked", () => {
				handleDisconnectRoom();
				DisconnectedDialog.call({
					title: t("connectRoomDialog.kicked"),
					description: t("connectRoomDialog.kickedDescription"),
				});
			});

			// Only the encrypted transport can raise this: the host is the sole
			// source of the document, so nothing arrives if it is not there.
			collab.on("syncTimeout", () => {
				handleDisconnectRoom();
				DisconnectedDialog.call({
					title: t("connectRoomDialog.syncTimeoutTitle"),
					description: t("connectRoomDialog.syncTimeout"),
				});
			});

			collab.on("roomClosed", () => {
				handleDisconnectRoom();
				DisconnectedDialog.call({
					title: encrypted
						? t("connectRoomDialog.hostDisconnectedTitle")
						: t("connectRoomDialog.roomClosed"),
					description: encrypted
						? t("connectRoomDialog.deviceSharingEnded")
						: t("connectRoomDialog.roomClosedDescription"),
				});
			});
		},
	);

	const handleConnectRoom = useEventCallback(
		async (
			roomId: string,
			userName: string,
			encodedRoomKey?: string,
		): Promise<{ error?: string } | undefined> => {
			// A key in the invite is what makes this an encrypted room; nothing
			// else distinguishes it, and the relay it talks to needs no account.
			const isEncryptedRoom = encodedRoomKey != null;
			let authToken: string | undefined;

			if (userName) {
				setCollaborationUserName(userName);
			}

			if (!isEncryptedRoom && process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud") {
				if (!session.isSignedIn) {
					collabState.pendingRoomId = roomId;
					collabState.signInDialogOpen = true;
					return;
				}

				authToken = (await session.getToken()) ?? undefined;
			}

			const pap = paplicoRef.current;
			if (!pap) return;

			const reconnect = getReconnectInfo();
			const currentDocId = documentManagerState.currentDocumentId;
			const provider = pap.getYjsProvider();

			let roomKey: CryptoKey | undefined;
			let isReconnect = false;

			if (encodedRoomKey) {
				try {
					roomKey = await importRoomKey(encodedRoomKey);
				} catch {
					return { error: t("connectRoomDialog.invalidRoomKey") };
				}

				// The relay keeps no room metadata to check against, so our own
				// reconnect record is the only evidence available here.
				isReconnect =
					reconnect?.roomId === roomId &&
					reconnect?.documentId === currentDocId;
			} else {
				// Verify room exists and determine reconnect eligibility
				const metaUrl =
					process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud"
						? `https://${process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999"}/parties/main/${roomId}`
						: `/api/collaboration/${roomId}/meta`;

				try {
					const metaRes = await fetch(metaUrl);
					if (!metaRes.ok) {
						return { error: t("connectRoomDialog.roomNotFound") };
					}

					const meta = (await metaRes.json()) as {
						documentId?: string;
					};
					isReconnect =
						reconnect?.roomId === roomId &&
						reconnect?.documentId === currentDocId &&
						meta.documentId === currentDocId;
				} catch {
					return { error: t("connectRoomDialog.roomNotFound") };
				}
			}

			if (!isReconnect) {
				const confirmed = await ConfirmDialog.call({
					description: t("menubar.saveAndCloseConfirm"),
					confirmLabel: t("menubar.saveAndContinue"),
				});
				if (!confirmed) return;

				// Save current document before discarding
				if (currentDocId && pap) {
					const doc = await pap.exportDocument();
					await saveDocument(currentDocId, doc);
				}
				provider.resetWithFreshDoc();
			}

			const collab = createCollaboration(
				provider,
				{
					roomId,
					wsUrl: isEncryptedRoom
						? undefined
						: `wss://${window.location.host}/api/collaboration`,
					user: { name: userName || undefined },
					authToken,
					roomKey,
				},
				{ isReconnect },
			);

			setupCollaborationListeners(collab, isEncryptedRoom);

			pap.setCollaboration(collab);
			encryptedRoomCredentials = roomKey ? { roomId, roomKey } : null;
			collabState.connectedRoomId = roomId;
			collabState.isEncryptedRoom = isEncryptedRoom;
			// The document still has to travel from a peer, and until it lands
			// the canvas on screen is the empty one this session started from.
			collabState.isSyncing = isEncryptedRoom;
			setReconnectInfo({
				roomId,
				documentId: documentManagerState.currentDocumentId ?? roomId,
			});
		},
	);

	const handleDisconnectRoom = useEventCallback(() => {
		paplicoRef.current?.clearCollaboration();
		encryptedRoomCredentials = null;
		collabState.connectedRoomId = null;
		collabState.isRoomOwner = false;
		collabState.publishedRoomId = null;
		collabState.inviteUrl = null;
		collabState.isEncryptedRoom = false;
		collabState.isSyncing = false;
		setReconnectInfo(null);
	});

	const markRoomPublished = useEventCallback(
		(roomId: string, encrypted: boolean) => {
			collabState.connectedRoomId = roomId;
			collabState.isRoomOwner = true;
			collabState.publishedRoomId = roomId;
			collabState.isEncryptedRoom = encrypted;
			setReconnectInfo({
				roomId,
				documentId: documentManagerState.currentDocumentId ?? roomId,
			});
		},
	);

	const handlePublishRoom = useEventCallback(
		async (
			encrypted: boolean,
		): Promise<{
			roomId: string;
			inviteUrl: string;
		} | null> => {
			const pap = paplicoRef.current;
			if (!pap) return null;

			if (encrypted) {
				const provider = pap.getYjsProvider();
				const currentDocId = documentManagerState.currentDocumentId;
				if (currentDocId) {
					provider.setDocumentId(currentDocId);
				}

				const roomId = generateRoomId();
				const roomKey = await generateRoomKey();

				// No readonly flag here: this exists to reach your own other device,
				// where locking yourself out of editing would be pointless.
				const collab = createCollaboration(provider, {
					roomId,
					user: { name: appConfig.collaborationUserName || undefined },
					roomKey,
					isOwner: true,
				});

				setupCollaborationListeners(collab, true);
				pap.setCollaboration(collab);
				encryptedRoomCredentials = { roomId, roomKey };

				// The key rides in the fragment so it is never sent to any server.
				const encodedKey = await exportRoomKey(roomKey);
				const inviteUrl = buildInviteUrl(inviteOrigin(), {
					roomId,
					encodedKey,
				});
				collabState.inviteUrl = inviteUrl;
				markRoomPublished(roomId, true);

				return { roomId, inviteUrl };
			}

			let authToken: string | undefined;
			if (process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud") {
				if (!session.isSignedIn) {
					collabState.signInDialogOpen = true;
					return null;
				}
				authToken = (await session.getToken()) ?? undefined;
			}

			const headers: Record<string, string> = {};
			if (authToken) {
				headers.Authorization = `Bearer ${authToken}`;
			}

			const res = await fetch("/api/rooms", {
				method: "POST",
				headers,
			});
			if (!res.ok) {
				reportError({ code: "ROOM_CREATE_FAILED", capture: false });
				return null;
			}

			const { roomId, roomToken } = (await res.json()) as {
				roomId: string;
				roomToken?: string;
			};
			const userName = appConfig.collaborationUserName || undefined;

			const provider = pap.getYjsProvider();
			const currentDocId = documentManagerState.currentDocumentId;
			if (currentDocId) {
				provider.setDocumentId(currentDocId);
			}

			const collab = createCollaboration(provider, {
				roomId,
				wsUrl: `wss://${window.location.host}/api/collaboration`,
				user: { name: userName },
				authToken,
				roomToken,
				isOwner: true,
				roomReadonly: collabState.publishedReadonly,
			});

			setupCollaborationListeners(collab, false);

			pap.setCollaboration(collab);
			const inviteUrl = buildInviteUrl(inviteOrigin(), { roomId });
			collabState.inviteUrl = inviteUrl;
			markRoomPublished(roomId, false);

			return { roomId, inviteUrl };
		},
	);

	/**
	 * Ends a device-to-device session. Distinct from closing a room: the device
	 * that handed out the code tells the others the session is over, while a
	 * device that merely joined just leaves.
	 */
	const handleStopDeviceSharing = useEventCallback(async () => {
		const confirmed = await ConfirmDialog.call({
			description: t("connectRoomDialog.stopConnectingConfirm"),
		});
		if (!confirmed) return;

		if (collabState.isRoomOwner) {
			paplicoRef.current?.getCollaboration()?.closeRoom();
		}

		handleDisconnectRoom();
	});

	const handleCloseRoom = useEventCallback(async () => {
		const confirmed = await ConfirmDialog.call({
			description: t("connectRoomDialog.closeRoomConfirm"),
		});
		if (!confirmed) return;

		const roomId = collabState.connectedRoomId;
		const wasEncrypted = collabState.isEncryptedRoom;

		const pap = paplicoRef.current;
		const collab = pap?.getCollaboration();
		collab?.closeRoom();

		pap?.clearCollaboration();
		collabState.connectedRoomId = null;
		collabState.isRoomOwner = false;
		collabState.publishedRoomId = null;
		collabState.inviteUrl = null;
		collabState.isEncryptedRoom = false;
		setReconnectInfo(null);

		// Encrypted rooms were never registered anywhere, so there is no history
		// to close out — the session is gone the moment the peers disconnect.
		if (wasEncrypted) return;

		// Record room closure in history (fire-and-forget)
		if (roomId) {
			const token = await session.getToken();
			if (token) {
				fetch(`/api/rooms/${roomId}`, {
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ closed_at: new Date().toISOString() }),
				}).catch(() => {});
			}
		}
	});

	const handleSignInComplete = useEventCallback(() => {
		collabState.signInDialogOpen = false;

		const pendingRoomId = collabState.pendingRoomId;
		if (pendingRoomId) {
			collabState.pendingRoomId = null;
			setTimeout(
				() => handleConnectRoom(pendingRoomId, appConfig.collaborationUserName),
				500,
			);
		}
	});

	return {
		connectedRoomId: snap.connectedRoomId,
		isRoomOwner: snap.isRoomOwner,
		publishedRoomId: snap.publishedRoomId,
		publishedReadonly: snap.publishedReadonly,
		inviteUrl: snap.inviteUrl,
		isEncryptedRoom: snap.isEncryptedRoom,
		isSyncing: snap.isSyncing,
		signInDialogOpen: snap.signInDialogOpen,
		pendingRoomId: snap.pendingRoomId,
		setSignInDialogOpen: (open: boolean) => {
			collabState.signInDialogOpen = open;
		},
		setPublishedReadonly: (v: boolean) => {
			collabState.publishedReadonly = v;
		},
		setPendingRoomId: (id: string | null) => {
			collabState.pendingRoomId = id;
		},
		handleConnectRoom,
		handleDisconnectRoom,
		handlePublishRoom,
		handleStopDeviceSharing,
		handleCloseRoom,
		handleSignInComplete,
	};
}
