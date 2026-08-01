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

export function detectMacOSTauri(): boolean {
	return (
		navigator.userAgent.includes("PaplicoDesktop") &&
		navigator.platform.startsWith("Mac")
	);
}
