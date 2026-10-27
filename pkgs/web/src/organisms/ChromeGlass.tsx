import type { CSSProperties } from "react";
import { useUIState } from "@/stores/uiStore";

/**
 * Frosted glass behind the menu bar and the tool rail, drawn as one L-shaped
 * layer. A single layer lets the inner corner where the two bars meet be
 * rounded without a seam, and keeps the corner concentric with the side
 * panels' corners so the gap around them stays even.
 *
 * The bars measure themselves as canvas obstacles; their sizes already
 * include the safe-area and notch insets.
 */
export function ChromeGlass({ side }: { side: "left" | "right" }) {
	const { canvasObstacles } = useUIState();
	const menubar = canvasObstacles.menubar;
	const toolbar = canvasObstacles.toolbar;
	if (!menubar) return null;

	const railWidth = toolbar ? toolbar.right - toolbar.left : 0;
	const corner = toolbar ? "var(--chrome-corner)" : "0px";
	const style = {
		"--chrome-bar": `${menubar.bottom - menubar.top}px`,
		"--chrome-rail": `${railWidth}px`,
		mask: [
			"linear-gradient(#000 0 0) 0 0 / 100% var(--chrome-bar) no-repeat",
			side === "left"
				? "linear-gradient(#000 0 0) 0 0 / var(--chrome-rail) 100% no-repeat"
				: "linear-gradient(#000 0 0) 100% 0 / var(--chrome-rail) 100% no-repeat",
			side === "left"
				? `radial-gradient(circle at 100% 100%, #0000 ${corner}, #000 calc(${corner} + 0.5px)) var(--chrome-rail) var(--chrome-bar) / ${corner} ${corner} no-repeat`
				: `radial-gradient(circle at 0% 100%, #0000 ${corner}, #000 calc(${corner} + 0.5px)) calc(100% - var(--chrome-rail)) var(--chrome-bar) / ${corner} ${corner} no-repeat`,
		].join(", "),
	} as CSSProperties;

	return (
		<div
			aria-hidden
			className="absolute inset-0 bg-background/80 backdrop-liquid pointer-events-none"
			style={style}
		/>
	);
}
