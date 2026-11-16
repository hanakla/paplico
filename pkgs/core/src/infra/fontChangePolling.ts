/**
 * Detects font installs and removals for backends the OS cannot notify:
 * lists the fonts once a minute and whenever the window regains focus, and
 * reports when the set of PostScript names differs from the last listing.
 */

export const FONT_POLL_INTERVAL_MS = 60_000;

export function pollFontChanges(
	listFonts: () => Promise<readonly { postScriptName: string }[]>,
	onChange: () => void,
): () => void {
	let fingerprint: string | null = null;
	let checking = false;

	const check = async () => {
		if (checking || document.hidden) return;
		checking = true;
		try {
			const next = fingerprintOf(await listFonts());
			if (fingerprint !== null && next !== fingerprint) onChange();
			fingerprint = next;
		} catch (error) {
			console.error("Failed to check local fonts for changes:", error);
		} finally {
			checking = false;
		}
	};

	void check();
	const timer = setInterval(check, FONT_POLL_INTERVAL_MS);
	window.addEventListener("focus", check);
	return () => {
		clearInterval(timer);
		window.removeEventListener("focus", check);
	};
}

function fingerprintOf(fonts: readonly { postScriptName: string }[]): string {
	return fonts
		.map((font) => font.postScriptName)
		.sort()
		.join("\n");
}
