import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Lazily loads Google Fonts CSS2 subsets as font items scroll into view.
 * Only fetches characters needed to render the font's own name.
 */

const BATCH_DELAY_MS = 100;
const BATCH_SIZE = 20;

/** Singleton: families whose preview CSS is already injected */
const loadedFamilies = new Set<string>();
const pendingFamilies = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers() {
	for (const cb of subscribers) cb();
}

function scheduleBatchFlush() {
	if (flushTimer != null) return;

	flushTimer = setTimeout(() => {
		flushTimer = null;

		const batch = [...pendingFamilies].slice(0, BATCH_SIZE);
		if (batch.length === 0) return;

		for (const f of batch) pendingFamilies.delete(f);

		const families = batch.map((f) => `family=${encodeURIComponent(f)}`);
		const chars = new Set<string>();
		for (const f of batch) {
			for (const ch of f) chars.add(ch);
		}
		const text = encodeURIComponent([...chars].join(""));
		const url = `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap&text=${text}`;

		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		link.onload = link.onerror = () => {
			for (const f of batch) loadedFamilies.add(f);
			notifySubscribers();

			// Flush remaining pending
			if (pendingFamilies.size > 0) scheduleBatchFlush();
		};
		document.head.appendChild(link);
	}, BATCH_DELAY_MS);
}

function requestPreview(family: string) {
	if (loadedFamilies.has(family) || pendingFamilies.has(family)) return;
	pendingFamilies.add(family);
	scheduleBatchFlush();
}

export function useFontPreview(): {
	previewReady: Set<string>;
	previewRef: (
		family: string,
		source: string,
	) => (el: HTMLElement | null) => void;
} {
	const [, rerender] = useState(0);
	const observerRef = useRef<IntersectionObserver | null>(null);
	const refMapRef = useRef(new Map<string, (el: HTMLElement | null) => void>());

	useEffect(() => {
		const cb = () => rerender((c) => c + 1);
		subscribers.add(cb);
		return () => {
			subscribers.delete(cb);
		};
	}, []);

	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const family = (entry.target as HTMLElement).dataset.fontFamily;
					if (family) {
						requestPreview(family);
						observer.unobserve(entry.target);
					}
				}
			},
			{ rootMargin: "100px 0px" },
		);
		observerRef.current = observer;
		return () => observer.disconnect();
	}, []);

	const previewRef = useCallback((family: string, source: string) => {
		const existing = refMapRef.current.get(family);
		if (existing) return existing;

		const refCb = (el: HTMLElement | null) => {
			if (!el || source !== "google" || loadedFamilies.has(family)) return;
			el.dataset.fontFamily = family;
			observerRef.current?.observe(el);
		};
		refMapRef.current.set(family, refCb);
		return refCb;
	}, []);

	return { previewReady: loadedFamilies, previewRef };
}
