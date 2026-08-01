/**
 * tauriAuth — OAuth authentication module for Tauri (dev + production).
 *
 * Clerk SDK is stubbed in production, and WKWebView blocks popup/redirect
 * OAuth in all environments, so we always open the system browser.
 *
 * Flow:
 * 1. Open /auth/app/start?strategy=xxx&state=yyy in the default system browser
 * 2. Clerk SDK in the browser handles the OAuth flow
 * 3. /auth/app/callback extracts the session token
 * 4. Token is relayed back to the Tauri webview via:
 *    - localhost callback (dev — tauri-plugin-oauth temporary server)
 *    - paplico://auth/callback deep link (prod — registered URL scheme)
 * 5. State is verified before the token is stored in localStorage
 */

import type { OAuthStrategy } from "./oauthProviders";

const TOKEN_STORAGE_KEY = "paplico_auth_token";
const AUTH_TIMEOUT_MS = 120_000;
const isDev = process.env.NODE_ENV === "development";

let authInFlight = false;
let pendingState: string | null = null;
let pendingResolve: ((token: string) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;

function generateState(): string {
	const buf = new Uint8Array(24);
	crypto.getRandomValues(buf);
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Called by the deep link listener when paplico://auth/callback is received.
 * Only used in production builds where the URL scheme is registered.
 */
export function handleAuthDeepLink(url: string): boolean {
	const parsed = new URL(url);

	const isAuthCallback =
		(parsed.host === "auth" && parsed.pathname === "/callback") ||
		(parsed.host === "" && parsed.pathname === "/auth/callback") ||
		parsed.pathname === "//auth/callback";
	if (!isAuthCallback) return false;

	// Token is relayed via URL fragment (not query params) to avoid exposure
	// in referrer headers and server logs. Fall back to searchParams for
	// backward compatibility.
	const hashParams = parsed.hash
		? new URLSearchParams(parsed.hash.slice(1))
		: null;
	const token = hashParams?.get("token") ?? parsed.searchParams.get("token");
	const state = hashParams?.get("state") ?? parsed.searchParams.get("state");

	if (!token) {
		pendingReject?.(new Error("No token in callback URL"));
		clearPending();
		return true;
	}

	if (!pendingState || state !== pendingState) {
		pendingReject?.(new Error("State mismatch — possible CSRF"));
		clearPending();
		return true;
	}

	storeToken(token);
	pendingResolve?.(token);
	clearPending();
	return true;
}

/**
 * Start OAuth authentication in the system browser.
 * Rejects immediately if another auth attempt is already in flight.
 */
export async function tauriAuthenticate(
	strategy: OAuthStrategy,
	webOrigin: string,
): Promise<string> {
	if (authInFlight) {
		throw new Error("Authentication already in progress");
	}
	authInFlight = true;

	try {
		const { openUrl } = await import("@tauri-apps/plugin-opener");

		if (isDev) {
			return await authenticateWithLocalhost(strategy, webOrigin, openUrl);
		}
		return await authenticateWithDeepLink(strategy, webOrigin, openUrl);
	} finally {
		authInFlight = false;
	}
}

/** Dev path: tauri-plugin-oauth localhost callback server */
async function authenticateWithLocalhost(
	strategy: OAuthStrategy,
	webOrigin: string,
	openUrl: (url: string) => Promise<void>,
): Promise<string> {
	const { start, cancel, onUrl } = await import(
		"@fabianlars/tauri-plugin-oauth"
	);

	const port = await start();
	const state = generateState();

	return new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cancel(port);
			reject(new Error("Authentication timed out"));
		}, AUTH_TIMEOUT_MS);

		onUrl((callbackUrl) => {
			clearTimeout(timeout);
			cancel(port);

			const parsed = new URL(callbackUrl);
			const token = parsed.searchParams.get("token");
			const returnedState = parsed.searchParams.get("state");

			if (!token) {
				reject(new Error("No token in localhost callback URL"));
				return;
			}

			if (returnedState !== state) {
				reject(new Error("State mismatch — possible CSRF"));
				return;
			}

			storeToken(token);
			resolve(token);
		});

		const startUrl =
			`${webOrigin}/auth/app/start` +
			`?strategy=${encodeURIComponent(strategy)}` +
			`&callback=localhost` +
			`&callback_port=${port}` +
			`&state=${encodeURIComponent(state)}`;

		openUrl(startUrl).catch((err) => {
			clearTimeout(timeout);
			cancel(port);
			reject(new Error(`Failed to open browser: ${err}`));
		});
	});
}

/** Prod path: paplico:// deep link callback */
function authenticateWithDeepLink(
	strategy: OAuthStrategy,
	webOrigin: string,
	openUrl: (url: string) => Promise<void>,
): Promise<string> {
	const state = generateState();

	const startUrl =
		`${webOrigin}/auth/app/start` +
		`?strategy=${encodeURIComponent(strategy)}` +
		`&callback=deeplink` +
		`&state=${encodeURIComponent(state)}`;

	return new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			clearPending();
			reject(new Error("Authentication timed out"));
		}, AUTH_TIMEOUT_MS);

		pendingState = state;
		pendingResolve = (token) => {
			clearTimeout(timeout);
			resolve(token);
		};
		pendingReject = (error) => {
			clearTimeout(timeout);
			reject(error);
		};

		openUrl(startUrl).catch((err) => {
			clearTimeout(timeout);
			clearPending();
			reject(new Error(`Failed to open browser: ${err}`));
		});
	});
}

function clearPending(): void {
	pendingState = null;
	pendingResolve = null;
	pendingReject = null;
}

function storeToken(token: string): void {
	localStorage.setItem(TOKEN_STORAGE_KEY, token);
	// StorageEvent doesn't fire from the same tab — dispatch manually
	// so useSyncExternalStore in useUserSessionTauri re-renders.
	window.dispatchEvent(new StorageEvent("storage", { key: TOKEN_STORAGE_KEY }));
}

export function getTauriToken(): string | null {
	return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearTauriToken(): void {
	localStorage.removeItem(TOKEN_STORAGE_KEY);
	window.dispatchEvent(new StorageEvent("storage", { key: TOKEN_STORAGE_KEY }));
	clearPending();
}
