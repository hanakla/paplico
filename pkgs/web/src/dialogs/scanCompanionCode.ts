import { importRoomKey } from "@/core/collaboration/roomCrypto";
import { parseSessionCode } from "@/core/collaboration/sessionCode";
import { ScanInviteDialog } from "@/dialogs/ScanInviteDialog";
import type { CompanionCredentials } from "@/hooks/useCompanionClient";

type ScanCompanionCodeResult =
	| { status: "ok"; credentials: CompanionCredentials }
	/** The camera was closed without reading anything. Nothing to report. */
	| { status: "cancelled" }
	/** Something was read, but it was not a companion code. Worth saying. */
	| { status: "unusable" };

/**
 * Opens the camera and turns whatever it reads into a host worth connecting to.
 *
 * A camera reads anything put in front of it, and a room code carries the same
 * two values as a companion code while meaning something else entirely, so the
 * kind is checked before the key is ever imported.
 */
export async function scanCompanionCode(): Promise<ScanCompanionCodeResult> {
	const scanned = await ScanInviteDialog.call({});
	if (!scanned) return { status: "cancelled" };

	const code = parseSessionCode(scanned);
	if (code?.kind !== "companion") return { status: "unusable" };

	try {
		return {
			status: "ok",
			credentials: {
				roomId: code.roomId,
				roomKey: await importRoomKey(code.encodedKey),
			},
		};
	} catch {
		return { status: "unusable" };
	}
}
