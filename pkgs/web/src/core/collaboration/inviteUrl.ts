/**
 * Invite URL format for collaboration rooms.
 *
 * The room key is carried in the fragment, which browsers never put on the
 * wire. That is what keeps an encrypted session's key away from every server
 * involved — including the one serving the page.
 *
 * Both the web link and the desktop deep link use this shape:
 *   https://<origin>/?room=<roomId>#k=<encodedKey>
 *   paplico://join?room=<roomId>#k=<encodedKey>
 */

const ROOM_PARAM = "room";
const KEY_FRAGMENT_PARAM = "k";

export type InviteTarget = {
	roomId: string;
	/** Absent for rooms that are not end-to-end encrypted. */
	encodedKey?: string;
};

export function buildInviteUrl(origin: string, invite: InviteTarget): string {
	return appendInvite(`${origin}/`, invite);
}

export function buildDeepLinkUrl(invite: InviteTarget): string {
	return appendInvite("paplico://join", invite);
}

/** Link to the companion remote control, for handing over by hand. */
export function buildCompanionUrl(
	origin: string,
	invite: InviteTarget,
): string {
	return appendInvite(`${origin}/companion`, invite);
}

/**
 * Accepts a full invite URL, a deep link, or a bare room id. Returns null when
 * the input carries no room id at all.
 */
export function parseInvite(input: string): InviteTarget | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		// Not a URL, so treat the whole input as a room id typed by hand.
		return { roomId: trimmed };
	}

	const roomId = url.searchParams.get(ROOM_PARAM);
	if (!roomId) return null;

	const encodedKey = new URLSearchParams(url.hash.replace(/^#/, "")).get(
		KEY_FRAGMENT_PARAM,
	);

	return encodedKey ? { roomId, encodedKey } : { roomId };
}

/** Reads the key a browser is currently holding in its address bar fragment. */
export function readKeyFromFragment(hash: string): string | null {
	return new URLSearchParams(hash.replace(/^#/, "")).get(KEY_FRAGMENT_PARAM);
}

function appendInvite(base: string, invite: InviteTarget): string {
	const withRoom = `${base}?${ROOM_PARAM}=${encodeURIComponent(invite.roomId)}`;
	return invite.encodedKey
		? `${withRoom}#${KEY_FRAGMENT_PARAM}=${invite.encodedKey}`
		: withRoom;
}
