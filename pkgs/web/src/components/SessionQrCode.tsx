import { memo } from "react";
import QRCode from "react-qr-code";

/**
 * A session code shown for another device to photograph.
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
		// Kept on a white plate so the code stays scannable in either theme
		<div className="bg-white p-3 rounded-lg">
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
