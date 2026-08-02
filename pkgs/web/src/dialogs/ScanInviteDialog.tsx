import { Camera, X as XIcon } from "lucide-react";
import QrScanner from "qr-scanner";
import { useEffect, useRef, useState } from "react";
import { createCallable } from "react-call";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Spinner } from "@/components/Spinner";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Camera view that resolves with the raw text of the first QR code it sees,
 * or null when the user backs out. Interpreting that text (invite URL or not)
 * is left to the caller.
 *
 * Installed (standalone) web apps on iOS cannot rely on getUserMedia — WebKit
 * has repeatedly shipped broken camera capture there — so in that mode the
 * dialog asks for a photo through the native camera UI and decodes it instead.
 */
export const ScanInviteDialog = createCallable<
	Record<never, never>,
	string | null
>(({ call }) => {
	const t = useTranslation();
	const videoRef = useRef<HTMLVideoElement>(null);
	const photoInputRef = useRef<HTMLInputElement>(null);
	const [standalone] = useState(isStandaloneDisplay);
	const [cameraFailed, setCameraFailed] = useState(false);
	const [photoHadNoCode, setPhotoHadNoCode] = useState(false);
	// Reading a photo takes seconds, and a button that does nothing for that
	// long reads as one that did not work.
	const [scanning, setScanning] = useState(false);

	const handleDecode = useEventCallback((result: QrScanner.ScanResult) => {
		call.end(result.data);
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: useEventCallback keeps a stable reference
	useEffect(() => {
		if (standalone) return;

		const video = videoRef.current;
		if (!video) return;

		const scanner = new QrScanner(video, handleDecode, {
			returnDetailedScanResult: true,
			preferredCamera: "environment",
		});
		scanner.start().catch(() => setCameraFailed(true));

		return () => {
			scanner.destroy();
		};
	}, [standalone]);

	const handleTakePhoto = useEventCallback(() => {
		photoInputRef.current?.click();
	});

	const handlePhotoChange = useEventCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			e.target.value = "";
			if (!file) return;

			setScanning(true);
			const data = await readCodeFromPhoto(file);
			setScanning(false);

			if (data == null) {
				setPhotoHadNoCode(true);
				return;
			}
			call.end(data);
		},
	);

	const handleClose = useEventCallback(() => {
		call.end(null);
	});

	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) call.end(null);
	});

	return (
		<Dialog.Root open onOpenChange={handleOpenChange}>
			<Dialog.Content className="w-90 p-0 flex flex-col">
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("connectRoomDialog.scanCode")}
					</Dialog.Title>
					<Dialog.Close>
						<button
							type="button"
							className="p-1 rounded hover:bg-foreground/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
						>
							<XIcon size={16} />
						</button>
					</Dialog.Close>
				</div>

				{standalone ? (
					<div className="p-4 space-y-3">
						<p className="text-xs text-muted-foreground">
							{photoHadNoCode
								? t("connectRoomDialog.scanPhotoNoCode")
								: t("connectRoomDialog.scanPhotoGuide")}
						</p>
						<Button
							$variant="default"
							$size="sm"
							className="w-full justify-center"
							disabled={scanning}
							onClick={handleTakePhoto}
						>
							{scanning ? <Spinner $size="sm" /> : <Camera size={14} />}
							{scanning
								? t("connectRoomDialog.scanReadingPhoto")
								: t("connectRoomDialog.scanTakePhoto")}
						</Button>
						<input
							ref={photoInputRef}
							type="file"
							accept="image/*"
							capture="environment"
							className="hidden"
							onChange={handlePhotoChange}
						/>
					</div>
				) : (
					<div className="p-4 space-y-3">
						<div className="relative aspect-square rounded-lg overflow-hidden bg-black">
							{/* biome-ignore lint/a11y/useMediaCaption: live camera preview has no captions */}
							<video
								ref={videoRef}
								className="absolute inset-0 w-full h-full object-cover"
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{cameraFailed
								? t("connectRoomDialog.scanCameraError")
								: t("connectRoomDialog.scanCodeGuide")}
						</p>
					</div>
				)}

				<div className="flex justify-end px-4 py-3 border-t border-border/30">
					<Button $variant="ghost" $size="sm" onClick={handleClose}>
						{t("connectRoomDialog.cancel")}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});

/** Long edge the first decoding pass works at. */
const PHOTO_SCAN_EDGE = 1600;

/**
 * Reads a code out of a photo, or returns null.
 *
 * A phone camera hands over twelve megapixels, nearly all of it not the code.
 * The decoder is given a downscaled copy first: that is what a normally framed
 * shot succeeds on, and it returns well inside the ten seconds the decoder
 * allows itself, where the full frame can spend all of them and give up. Full
 * resolution follows only when the small copy finds nothing, which is the case
 * for a code photographed from across the room.
 */
async function readCodeFromPhoto(file: File): Promise<string | null> {
	const downscaled = await downscalePhoto(file, PHOTO_SCAN_EDGE);

	for (const image of downscaled ? [downscaled, file] : [file]) {
		try {
			const result = await QrScanner.scanImage(image, {
				returnDetailedScanResult: true,
			});
			return result.data;
		} catch {
			// Nothing found at this size; the next one may still have it.
		}
	}

	return null;
}

/** Null when the photo is already small enough, or cannot be read at all. */
async function downscalePhoto(
	file: File,
	maxEdge: number,
): Promise<HTMLCanvasElement | null> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}

	try {
		const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
		if (scale >= 1) return null;

		const canvas = document.createElement("canvas");
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		canvas
			.getContext("2d")
			?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas;
	} finally {
		bitmap.close();
	}
}

/**
 * True when running as an installed (home screen) web app. iOS exposes the
 * legacy `navigator.standalone` flag; everything else reports display-mode.
 */
function isStandaloneDisplay(): boolean {
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		("standalone" in navigator && navigator.standalone === true)
	);
}
