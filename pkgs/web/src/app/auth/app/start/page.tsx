"use client";

/**
 * /auth/app/start — OAuth initiation page for Tauri (dev + production).
 *
 * Opened in the system browser by the Tauri app.
 * Reads OAuth parameters from the URL and redirects to the Supabase OAuth
 * endpoint via /api/auth/oauth, which handles provider consent and callback.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

export const dynamic = "force-dynamic";

function TauriStartInner() {
	const searchParams = useSearchParams();
	const initiatedRef = useRef(false);

	const strategy = searchParams.get("strategy");
	const callbackName =
		searchParams.get("callback_name") ?? searchParams.get("callback");
	const callbackPort = searchParams.get("callback_port");
	const state = searchParams.get("state");

	useEffect(() => {
		if (initiatedRef.current) return;
		if (!strategy) return;
		initiatedRef.current = true;

		// Store callback info for app/callback page to relay token
		if (callbackName)
			sessionStorage.setItem("paplico_callback_name", callbackName);
		if (callbackPort)
			sessionStorage.setItem("paplico_callback_port", callbackPort);
		if (state) sessionStorage.setItem("paplico_auth_state", state);

		const params = new URLSearchParams();
		params.set("provider", strategy);
		if (callbackName) params.set("callback", callbackName);
		if (callbackPort) params.set("port", callbackPort);
		if (state) params.set("state", state);

		window.location.href = `${window.location.origin}/api/auth/oauth?${params.toString()}`;
	}, [strategy, callbackName, callbackPort, state]);

	if (!strategy) {
		return <p>Missing strategy parameter</p>;
	}

	return <p>Redirecting to authentication provider…</p>;
}

export default function TauriStartPage() {
	return (
		<Suspense fallback={<p>Loading…</p>}>
			<TauriStartInner />
		</Suspense>
	);
}
