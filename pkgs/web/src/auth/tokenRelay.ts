/**
 * tokenRelay — Relay a Clerk session token from the system browser back to the Tauri app.
 *
 * Used by /auth/app/start and /auth/app/callback pages (running in the system browser)
 * to send the authenticated token back to the Tauri webview.
 *
 * Two mechanisms are used depending on the callback name:
 * - "localhost": HTTP redirect to localhost:{port} where tauri-plugin-oauth
 *   runs a temporary server inside the Tauri process.
 * - "deeplink" (or absent): paplico:// deep link redirect, received by tauri-plugin-deep-link.
 *
 * The callback destination is determined by a name, not a raw URL,
 * so the redirect target cannot be hijacked via query parameter injection.
 */

/** Allowed callback names and their URL builders. */
type CallbackName = "localhost" | "deeplink";

/**
 * Relay token back to the Tauri app.
 * @param token  Clerk session token
 * @param state  OAuth state nonce for CSRF verification
 * @param callbackName  Named callback destination ("localhost" or "deeplink")
 * @param callbackPort  Port for localhost callback (only used when callbackName is "localhost")
 */
export function relayTokenToTauriApp(
	token: string,
	state: string,
	callbackName?: CallbackName | string | null,
	callbackPort?: string | null,
): void {
	if (callbackName === "localhost") {
		const port = Number(callbackPort);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error("Invalid callback port");
		}

		const redirectUrl = new URL("http://localhost/");
		redirectUrl.port = String(port);
		redirectUrl.searchParams.set("token", token);
		redirectUrl.searchParams.set("state", state);
		window.location.href = redirectUrl.toString();
	} else {
		// Default: deep link
		// Use URL fragment instead of query params — fragments are not sent in
		// HTTP referrer headers, server logs, or browser history entries.
		const redirectUrl = new URL("paplico://auth/callback");
		redirectUrl.hash = `token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
		window.location.href = redirectUrl.toString();
	}
}
