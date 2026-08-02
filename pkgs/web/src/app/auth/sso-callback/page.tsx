"use client";

import { useEffect } from "react";

export default function SSOCallbackPage() {
	useEffect(() => {
		const hash = window.location.hash.slice(1);
		const params = new URLSearchParams(hash);
		const token = params.get("access_token");

		if (window.opener) {
			window.opener.postMessage(
				{ type: "supabase-auth-complete", token },
				window.location.origin,
			);
		}

		window.close();
	}, []);

	return null;
}
