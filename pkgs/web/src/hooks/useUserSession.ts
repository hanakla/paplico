"use client";

/**
 * useUserSession - Application abstraction layer for auth state.
 *
 * All auth operations go through API routes — no direct Supabase client usage.
 * Token state managed via valtio proxy for reactive updates.
 *
 * Environment routing:
 * - Tauri (any env) + cloud → useUserSessionTauri (system browser OAuth via deep link)
 * - Browser + cloud → useUserSessionCloud (popup OAuth via API routes)
 * - Non-cloud → useUserSessionLocal (no-op)
 */

import { useMemo, useSyncExternalStore } from "react";
import { proxy, useSnapshot } from "valtio";
import type { OAuthStrategy } from "@/auth/oauthProviders";
import {
	clearTauriToken,
	getTauriToken,
	tauriAuthenticate,
} from "@/auth/tauriAuth";
import { useEventCallback } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";

const isCloudMode = process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud";

const TOKEN_KEY = "paplico_auth_token";

type UserSession = {
	isSignedIn: boolean;
	user: {
		id: string | null;
		fullName: string | null;
		username: string | null;
		imageUrl: string | null;
		primaryEmail: string | null;
	} | null;
	signOut: () => Promise<void>;
	getToken: () => Promise<string | null>;
	authenticate: (strategy: OAuthStrategy) => Promise<void>;
	deleteAccount: () => Promise<void>;
};

const NOOP_ASYNC = () => Promise.resolve();

const EMPTY_SESSION: UserSession = {
	isSignedIn: false,
	user: null,
	signOut: NOOP_ASYNC,
	getToken: () => Promise.resolve(null),
	authenticate: NOOP_ASYNC,
	deleteAccount: NOOP_ASYNC,
};

const authState = proxy({
	token: typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null,
});

function setAuthToken(token: string | null) {
	authState.token = token;
	if (token) {
		localStorage.setItem(TOKEN_KEY, token);
	} else {
		localStorage.removeItem(TOKEN_KEY);
	}
}

function useUserSessionCloud(): UserSession {
	const snap = useSnapshot(authState);
	const token = snap.token as string | null;

	const user = useMemo(() => (token ? decodeJwtUser(token) : null), [token]);

	const authenticate = useEventCallback(async (strategy: OAuthStrategy) => {
		if (token && !isJwtExpired(token)) return;

		const origin = window.location.origin;

		// Open popup synchronously in click handler to avoid popup blockers
		const popup = window.open("", "_blank", "width=500,height=600");
		if (!popup) return;

		const res = await fetch(
			`/api/auth/oauth?provider=${strategy}&callback=popup&state=browser`,
		);

		if (!res.ok) {
			popup.close();
			return;
		}

		const { url } = (await res.json()) as { url: string };
		if (!url) {
			popup.close();
			return;
		}

		popup.location = url;

		await new Promise<void>((resolve, reject) => {
			const closedPoll = setInterval(() => {
				if (popup.closed) {
					clearInterval(closedPoll);
					window.removeEventListener("message", handler);
					reject(new Error("Popup closed by user"));
				}
			}, 500);

			const handler = (e: MessageEvent) => {
				if (e.origin === origin && e.data?.type === "supabase-auth-complete") {
					clearInterval(closedPoll);
					window.removeEventListener("message", handler);
					const authToken = e.data.token as string | undefined;
					if (authToken) {
						setAuthToken(authToken);
					}
					resolve();
				}
			};
			window.addEventListener("message", handler);
		}).catch(() => {
			// User closed the popup before completing auth
		});
	});

	const signOut = useEventCallback(async () => {
		setAuthToken(null);
	});

	const getToken = useEventCallback(async () => {
		return token && !isJwtExpired(token) ? token : null;
	});

	const deleteAccount = useEventCallback(async () => {
		if (!token || isJwtExpired(token)) return;
		await fetch("/api/auth/delete-account", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		setAuthToken(null);
	});

	return {
		isSignedIn: token !== null && !isJwtExpired(token),
		user,
		signOut,
		getToken,
		authenticate,
		deleteAccount,
	};
}

function useUserSessionTauri(): UserSession {
	const token = useSyncExternalStore(
		(cb) => {
			const handler = (e: StorageEvent) => {
				if (e.key === TOKEN_KEY) cb();
			};
			window.addEventListener("storage", handler);
			return () => window.removeEventListener("storage", handler);
		},
		() => getTauriToken(),
		() => null,
	);

	const user = useMemo(() => (token ? decodeJwtUser(token) : null), [token]);

	const authenticate = useEventCallback(async (strategy: OAuthStrategy) => {
		const webOrigin = window.location.origin;
		await tauriAuthenticate(strategy, webOrigin);
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: authenticate is from useEventCallback (stable ref)
	return useMemo(
		(): UserSession => ({
			isSignedIn: token !== null && !isJwtExpired(token),
			user,
			signOut: async () => clearTauriToken(),
			getToken: () =>
				Promise.resolve(token && !isJwtExpired(token) ? token : null),
			authenticate,
			deleteAccount: async () => {
				if (!token || isJwtExpired(token)) return;
				await fetch("/api/auth/delete-account", {
					method: "POST",
					headers: { Authorization: `Bearer ${token}` },
				});
				clearTauriToken();
			},
		}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[token, user],
	);
}

function decodeBase64Url(base64url: string): string {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const padding = (4 - (base64.length % 4)) % 4;
	const padded = base64 + "=".repeat(padding);
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function isJwtExpired(token: string): boolean {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return true;
		const payload: { exp?: number } = JSON.parse(decodeBase64Url(parts[1]));
		if (typeof payload.exp !== "number") return false;
		return payload.exp < Date.now() / 1000;
	} catch {
		return true;
	}
}

function decodeJwtUser(token: string): UserSession["user"] {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const payload: {
			sub?: string;
			email?: string;
			exp?: number;
			user_metadata?: {
				full_name?: string;
				avatar_url?: string;
				user_name?: string;
				preferred_username?: string;
			};
		} = JSON.parse(decodeBase64Url(parts[1]));

		if (!payload.sub) return null;
		if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
			return null;
		}

		const meta = payload.user_metadata;
		return {
			id: payload.sub,
			fullName: meta?.full_name ?? null,
			username: meta?.preferred_username ?? meta?.user_name ?? payload.sub,
			imageUrl: `/api/user/${payload.sub}/avatar`,
			primaryEmail: payload.email ?? null,
		};
	} catch {
		return null;
	}
}

function useUserSessionLocal(): UserSession {
	return EMPTY_SESSION;
}

export const useUserSession: () => UserSession =
	IS_TAURI_ENV && isCloudMode
		? useUserSessionTauri
		: isCloudMode
			? useUserSessionCloud
			: useUserSessionLocal;
