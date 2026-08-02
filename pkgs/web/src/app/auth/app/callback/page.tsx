"use client";

/**
 * /auth/app/callback — OAuth callback relay page for Tauri (dev + production).
 *
 * After the /api/auth/callback route processes the OAuth response, it redirects
 * here with token and state in the URL fragment (hash).
 * This page reads those values and relays the token back to the Tauri app via
 * the tokenRelay mechanism (localhost redirect or deep link).
 *
 * For the primary Tauri flow, /api/auth/callback redirects directly to
 * localhost or paplico:// deep link. This page serves as a fallback for cases
 * where the redirect lands in the browser instead.
 */

import { useEffect, useRef, useState } from "react";
import { relayTokenToTauriApp } from "@/auth/tokenRelay";

export const dynamic = "force-dynamic";

function parseHashParams(hash: string): URLSearchParams {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	return new URLSearchParams(raw);
}

function TokenRelay() {
	const relayedRef = useRef(false);
	const [status, setStatus] = useState("Completing authentication…");

	useEffect(() => {
		if (relayedRef.current) return;

		const params = parseHashParams(window.location.hash);
		const token = params.get("access_token") ?? params.get("token");
		const state = params.get("state");

		if (!token) {
			setStatus("No token received — authentication may have failed.");
			return;
		}

		relayedRef.current = true;

		// Read callback info stored by app/start before the OAuth redirect
		const callbackName = sessionStorage.getItem("paplico_callback_name");
		const callbackPort = sessionStorage.getItem("paplico_callback_port");
		const savedState = sessionStorage.getItem("paplico_auth_state");

		setStatus("Authentication complete. Returning to Paplico…");
		relayTokenToTauriApp(
			token,
			state ?? savedState ?? "",
			callbackName,
			callbackPort,
		);
	}, []);

	return <p>{status}</p>;
}

export default function TauriCallbackPage() {
	return <TokenRelay />;
}
