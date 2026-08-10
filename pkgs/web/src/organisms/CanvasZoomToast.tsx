import { useEffect, useRef, useState } from "react";
import { useTargetViewport } from "@/contexts/ViewIdContext";
import { useTranslation } from "@/locales";
import { twm } from "@/utils/tailwind";

// How long the readout lingers after the last scale change before it fades out.
const HIDE_DELAY_MS = 1200;

/**
 * Transient readout of the canvas scale, shown top-center while the user zooms
 * and fading out shortly after they stop. Mirrors MaskEditBar's floating-bar
 * look. Lives inside ViewIdProvider so it reads this pane's own viewport.
 */
export function CanvasZoomToast() {
	const { zoom } = useTargetViewport();
	const t = useTranslation();
	const previousZoomRef = useRef(zoom);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		// Only react to an actual scale change, not the initial mount or a pan.
		if (previousZoomRef.current === zoom) return;
		previousZoomRef.current = zoom;

		setVisible(true);
		if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
		hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
	}, [zoom]);

	useEffect(
		() => () => {
			if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
		},
		[],
	);

	return (
		<div
			aria-hidden={!visible}
			className="pointer-events-none absolute inset-x-0 z-10 flex justify-center top-[calc(2.5rem+var(--spacing-safe-top)+0.5rem)]"
		>
			<div
				className={twm(
					"flex items-center rounded-md border border-border bg-background/95 px-3 py-1.5 shadow-md backdrop-blur transition-opacity duration-200",
					visible ? "opacity-100" : "opacity-0",
				)}
			>
				<span className="text-xs font-medium tabular-nums text-foreground">
					{t("canvasZoomToast.scale", { value: zoom.toFixed(2) })}
				</span>
			</div>
		</div>
	);
}
