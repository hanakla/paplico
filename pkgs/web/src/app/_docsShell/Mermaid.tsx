"use client";

import { useEffect, useRef, useState } from "react";

let idCounter = 0;

export function Mermaid({ $chart }: { $chart: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el || !$chart.trim()) return;

		let cancelled = false;

		(async () => {
			try {
				const { default: mermaid } = await import("mermaid");
				if (cancelled) return;

				mermaid.initialize({ startOnLoad: false, theme: "neutral" });
				const id = `mermaid-${++idCounter}`;
				const { svg } = await mermaid.render(id, $chart.trim());
				if (cancelled) return;

				el.innerHTML = svg;
			} catch (e) {
				if (!cancelled) setError(String(e));
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [$chart]);

	if (error) {
		return (
			<pre className="my-4 overflow-x-auto rounded-lg bg-danger/10 p-4 text-sm text-danger">
				{error}
			</pre>
		);
	}

	return (
		<div
			ref={containerRef}
			className="my-4 flex justify-center [&_svg]:max-w-full"
		>
			<span className="text-sm text-muted-foreground">
				Rendering diagram...
			</span>
		</div>
	);
}
