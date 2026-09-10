import {
	type DependencyList,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

/** Hooks that returns a stable callback function reference */
export function useEventCallback<T extends (...args: any[]) => any>(fn: T): T {
	const latestRef = useRef<T | null>(null);
	const stableRef = useRef<T | null>(null);

	if (stableRef.current == null) {
		stableRef.current = function (this: unknown, ...args: unknown[]) {
			return latestRef.current?.apply(this, args);
		} as T;
	}

	useLayoutEffect(() => {
		latestRef.current = fn;
	}, [fn]);

	return stableRef.current;
}

export function useAsyncEffect(
	fn: (signal: AbortSignal) => void | Promise<void>,
	deps?: DependencyList,
) {
	return useEffect(() => {
		const abort = new AbortController();

		void fn(abort.signal);

		return () => {
			abort.abort();
		};

		// biome-ignore lint/correctness/useExhaustiveDependencies: expected
	}, deps);
}

export function useMediaQuery(query: string): boolean {
	const subscribe = useEventCallback((callback: () => void) => {
		const mql = matchMedia(query);
		mql.addEventListener("change", callback);
		return () => mql.removeEventListener("change", callback);
	});

	const getSnapshot = useEventCallback(() => matchMedia(query).matches);

	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useMediaDynamicRange(): "high" | "standard" {
	const isHigh = useMediaQuery("(dynamic-range: high)");
	return isHigh ? "high" : "standard";
}

// Detect which side the notch/Dynamic Island is on in landscape.
// Uses screen.orientation.type when available, falls back to
// matchMedia + window dimensions for iOS Safari < 16.4.
// Returns null in portrait.
type NotchSide = "left" | "right" | null;

function getNotchSide(): NotchSide {
	if (typeof window === "undefined") return null;

	// Prefer screen.orientation API
	const type = screen.orientation?.type;
	if (type === "landscape-primary") return "left";
	if (type === "landscape-secondary") return "right";
	if (type) return null; // portrait-primary/secondary → not landscape

	// Fallback for iOS Safari where screen.orientation may be unavailable.
	// window.orientation is deprecated but still works on iOS Safari.
	// 90 = notch on left, -90 = notch on right.
	const wo = (window as any).orientation as number | undefined;
	if (wo === 90) return "left";
	if (wo === -90) return "right";
	return null;
}

export function useNotchSide(): NotchSide {
	const [side, setSide] = useState<NotchSide>(getNotchSide);

	useEffect(() => {
		const update = () => setSide(getNotchSide());

		screen.orientation?.addEventListener("change", update);
		window.addEventListener("orientationchange", update);

		return () => {
			screen.orientation?.removeEventListener("change", update);
			window.removeEventListener("orientationchange", update);
		};
	}, []);

	return side;
}
