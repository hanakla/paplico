import { memo } from "react";
import QRCode from "react-qr-code";

/**
 * An invite link shown for another device to photograph.
 *
 * Sized and corrected for a screen rather than paper: react-qr-code defaults
 * to the lowest error correction, which leaves nothing spare for the glare,
 * moiré and slight blur a phone picks up off a display, and a code drawn small
 * puts each module within a few pixels of what a camera can still tell apart.
 */
export const SessionQrCode = memo(function SessionQrCode({
	value,
	title,
}: {
	value: string;
	title: string;
}) {
	return (
		// White plate so the code stays scannable in either theme. Its padding is
		// also the code's quiet zone — the white border a decoder needs in order
		// to find the code at all — because react-qr-code draws none of its own:
		// the viewBox it emits is the module grid and nothing more.
		//
		// The spec asks for four modules. 26px covers the shortest link we emit,
		// at 37 modules across 240px. A longer link only adds modules, and more
		// modules in the same 240px makes each one smaller, so four of them never
		// ask for more room than this.
		<div className="bg-white p-[26px] rounded-lg">
			<QRCode
				value={value}
				size={QR_SIZE}
				level={QR_ERROR_CORRECTION}
				title={title}
			/>
		</div>
	);
});

const QR_SIZE = 240;

/** 15% of the code may be lost and still read, against 7% at the default. */
const QR_ERROR_CORRECTION = "M";
