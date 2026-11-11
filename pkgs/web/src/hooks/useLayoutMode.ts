import { useEffect, useState } from "react";

// Layout mode breakpoints:
//   desktop:          width >= 768px (regardless of orientation/height)
//                     OR height >= 768px (tall window, e.g. desktop portrait)
//   portrait:         width < 768px AND height < 768px AND portrait orientation
//   landscape-compact: width < 768px AND height < 768px AND landscape orientation
//   null:             non-determinated
type LayoutMode = "desktop" | "landscape-compact" | "portrait";

const PORTRAIT_QUERY = "(width < 768px) and (orientation: portrait)";
const LANDSCAPE_COMPACT_QUERY = "(height < 768px) and (orientation: landscape)";
const TALL_DESKTOP_QUERY = "(width >= 768px) and (height >= 768px)";

function getMode(): LayoutMode | null {
	if (typeof window === "undefined") return null;
	// height >= 768 → always desktop regardless of orientation
	if (window.matchMedia(TALL_DESKTOP_QUERY).matches) return "desktop";
	if (window.matchMedia(PORTRAIT_QUERY).matches) return "portrait";
	if (window.matchMedia(LANDSCAPE_COMPACT_QUERY).matches)
		return "landscape-compact";
	return null;
}

export function useLayoutMode(): LayoutMode | null {
	const [mode, setMode] = useState<LayoutMode | null>(getMode);

	useEffect(() => {
		const tallDesktop = window.matchMedia(TALL_DESKTOP_QUERY);
		const portrait = window.matchMedia(PORTRAIT_QUERY);
		const landscapeCompact = window.matchMedia(LANDSCAPE_COMPACT_QUERY);

		const update = () => setMode(getMode());
		tallDesktop.addEventListener("change", update);
		portrait.addEventListener("change", update);
		landscapeCompact.addEventListener("change", update);

		return () => {
			tallDesktop.removeEventListener("change", update);
			portrait.removeEventListener("change", update);
			landscapeCompact.removeEventListener("change", update);
		};
	}, []);

	return mode;
}
