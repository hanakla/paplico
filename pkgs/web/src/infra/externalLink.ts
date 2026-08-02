import { IS_TAURI_ENV } from "@/utils/platform";

/**
 * Open a URL in the user's real browser.
 *
 * In the desktop build a plain anchor navigates the app's own webview, which
 * replaces Paplico with the target page and leaves no way back, so the OS
 * opener handles the URL instead.
 */
export async function openExternalUrl(url: string): Promise<void> {
	if (IS_TAURI_ENV) {
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		await openUrl(url);
		return;
	}

	globalThis.open(url, "_blank", "noopener,noreferrer");
}
