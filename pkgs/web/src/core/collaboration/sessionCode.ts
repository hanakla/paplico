/**
 * Session codes — what a QR on screen actually carries.
 *
 * The code is the same link a person would be handed by hand, so a phone's
 * own camera app can do something with it: reading one opens Paplico at the
 * right place with the room already named, without going through this app's
 * scanner at all.
 *
 * Paplico itself never follows the address. It takes the room id and the key
 * out of the link and connects from wherever it already is, because the
 * address a code was generated on is often wrong for whoever reads it: a
 * machine serving the page on its own loopback hands out a link that resolves
 * to the scanner's own machine.
 *
 * The kind rides in the path, because the two sessions do very different
 * things with the same pair of values — one shares a document, the other hands
 * over control of the tools — and reading one as the other would be silent and
 * confusing.
 */

import { type InviteTarget, parseInvite } from "./inviteUrl";

export type SessionCodeKind = "room" | "companion";

export type SessionCode = InviteTarget & {
	kind: SessionCodeKind;
	/** Codes are useless without the key, so this one is not optional. */
	encodedKey: string;
};

/** Path `buildCompanionUrl` puts a companion session on. */
const COMPANION_PATH = "/companion";

/**
 * Returns null for anything that is not one of our codes. A camera reads
 * whatever is put in front of it, so being handed something else is expected.
 */
export function parseSessionCode(text: string): SessionCode | null {
	const trimmed = text.trim();
	// The bare form is tried first because `paplico:` parses as a URL scheme,
	// which would send it down the link branch to be rejected there.
	return parseLegacyCode(trimmed) ?? parseInviteLink(trimmed);
}

function parseInviteLink(text: string): SessionCode | null {
	if (!URL.canParse(text)) return null;

	const invite = parseInvite(text);
	if (!invite?.encodedKey) return null;

	return {
		kind: isCompanionPath(new URL(text).pathname) ? "companion" : "room",
		roomId: invite.roomId,
		encodedKey: invite.encodedKey,
	};
}

function isCompanionPath(pathname: string): boolean {
	return pathname.replace(/\/+$/, "") === COMPANION_PATH;
}

/**
 * Codes minted while the QR carried a bare `paplico:kind:room:key` string.
 *
 * A host and the phone reading it are routinely on different builds — a
 * desktop app paired with a phone's browser is the whole point of a companion
 * session — so one side can still be handing these out after the other has
 * moved on.
 */
function parseLegacyCode(text: string): SessionCode | null {
	const [prefix, kind, roomId, encodedKey, ...rest] = text.split(":");
	if (rest.length || prefix !== "paplico") return null;
	if (kind !== "room" && kind !== "companion") return null;
	if (!roomId || !encodedKey) return null;

	return { kind, roomId, encodedKey };
}
