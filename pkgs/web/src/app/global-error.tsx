"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
	error,
}: {
	error: Error & { digest?: string };
}) {
	useEffect(() => {
		Sentry.captureException(error);
	}, [error]);

	return (
		<html lang="ja">
			<body>
				<div style={{ padding: "2rem", fontFamily: "system-ui" }}>
					<h2>Something went wrong</h2>
					<button type="button" onClick={() => window.location.reload()}>
						Reload page
					</button>
				</div>
			</body>
		</html>
	);
}
