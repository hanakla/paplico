export const IS_TAURI_ENV =
	process.env.NODE_ENV === "development"
		? navigator.userAgent.includes("PaplicoDesktop")
		: process.env.IS_TAURI_ENV === "1";

export function detectSafariBrowser(): boolean {
	if (typeof navigator === "undefined") return false;

	const ua = navigator.userAgent;
	const isSafariTokenPresent = ua.includes("Safari/");
	const isExcludedBrowser =
		/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|SamsungBrowser/.test(ua);

	return isSafariTokenPresent && !isExcludedBrowser;
}

/** Tells whether the page runs in Firefox, by its user agent. */
export function detectFirefoxBrowser(): boolean {
	if (typeof navigator === "undefined") return false;

	return navigator.userAgent.includes("Firefox/");
}

/**
 * Tells whether the app runs on a phone or tablet, by its user agent. Safari
 * on iPadOS reports itself as a Mac, so a Mac with a touch screen counts.
 */
export function detectMobileDevice(): boolean {
	if (typeof navigator === "undefined") return false;

	return (
		/iPhone|iPad|Android/.test(navigator.userAgent) ||
		(navigator.platform.startsWith("Mac") && navigator.maxTouchPoints > 1)
	);
}

/** Tells whether the app runs in the iOS or Android Tauri build. */
export function detectTauriMobile(): boolean {
	return IS_TAURI_ENV && /iPhone|iPad|Android/.test(navigator.userAgent);
}

export function detectMacOSTauri(): boolean {
	return (
		navigator.userAgent.includes("PaplicoDesktop") &&
		navigator.platform.startsWith("Mac")
	);
}
