/**
 * Session codes — what a QR on screen actually carries.
 *
 * A URL would have to name the address it was generated on, and that address
 * is often wrong for whoever reads it: a machine serving the page on its own
 * loopback hands out a link that resolves to the scanner's own machine. The
 * room id and key are the only parts that travel meaningfully, so those are
 * the only parts a code carries; the device that reads one connects from
 * wherever it already is.
 *
 * The kind is in the code because the two sessions do very different things
 * with the same pair of values — one shares a document, the other hands over
 * control of the tools — and reading one as the other would be silent and
 * confusing.
 */

import type { InviteTarget } from "./inviteUrl";

export type SessionCodeKind = "room" | "companion";

export type SessionCode = InviteTarget & {
	kind: SessionCodeKind;
	/** Codes are useless without the key, so this one is not optional. */
	encodedKey: string;
};

const PREFIX = "paplico";
const SEPARATOR = ":";

export function buildSessionCode(
	kind: SessionCodeKind,
	{ roomId, encodedKey }: { roomId: string; encodedKey: string },
): string {
	return [PREFIX, kind, roomId, encodedKey].join(SEPARATOR);
}

/**
 * Returns null for anything that is not one of our codes. A camera reads
 * whatever is put in front of it, so being handed something else is expected.
 */
export function parseSessionCode(text: string): SessionCode | null {
	const parts = text.trim().split(SEPARATOR);
	if (parts.length !== 4) return null;

	const [prefix, kind, roomId, encodedKey] = parts;
	if (prefix !== PREFIX) return null;
	if (kind !== "room" && kind !== "companion") return null;
	if (!roomId || !encodedKey) return null;

	return { kind, roomId, encodedKey };
}
