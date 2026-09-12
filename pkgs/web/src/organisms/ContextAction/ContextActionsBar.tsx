import { GripVertical } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { useAppConfig } from "@/hooks/useAppConfig";
import { type CanvasObstacleRect, uiState } from "@/stores/uiStore";
import { useEventCallback, useMediaQuery } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { clampBarPosition } from "./clampBarPosition";

/**
 * Chrome of the floating context actions bar: placement, the mobile edge fade
 * and the drag handle. The caller supplies the screen anchor the bar floats
 * above; the user's drag offset is applied here.
 */
export function ContextActionsBar({
	anchor,
	children,
}: {
	anchor: { x: number; y: number };
	children: React.ReactNode;
}) {
	const uiSnap = useSnapshot(uiState);
	// Phones: pin the bar to the top of the screen instead of floating it
	// near the selection (which drifts under the finger and off-screen).
	const isMobile = useMediaQuery("(max-width: 640px)");
	const toolbarOnRight = useAppConfig().toolbarSide === "right";

	// Edge fade is a scroll affordance: fade only the side that still has
	// content to scroll toward. Callback-ref state re-arms the observers when
	// the bar mounts (it unmounts whenever the selection clears).
	const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
	const [barFade, setBarFade] = useState({ left: false, right: false });
	const updateBarFade = useEventCallback(() => {
		const left = barEl != null && isMobile && barEl.scrollLeft > 1;
		const right =
			barEl != null &&
			isMobile &&
			barEl.scrollLeft + barEl.clientWidth < barEl.scrollWidth - 1;
		// Keep state identity when unchanged — the per-render re-measure below
		// must not trigger render loops
		setBarFade((prev) =>
			prev.left === left && prev.right === right ? prev : { left, right },
		);
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: updateBarFade is stable (useEventCallback)
	useEffect(() => {
		if (!barEl || !isMobile) return;
		updateBarFade();
		const observer = new ResizeObserver(updateBarFade);
		observer.observe(barEl);
		barEl.addEventListener("scroll", updateBarFade, { passive: true });
		return () => {
			observer.disconnect();
			barEl.removeEventListener("scroll", updateBarFade);
		};
	}, [barEl, isMobile]);
	// Content width changes (tool context swaps) don't resize the container
	// and emit no scroll event; re-measure after every render while pinned.
	useEffect(() => {
		updateBarFade();
	});

	// Placement needs the bar's own box and the pane it floats in, both of which
	// only the DOM knows. Measuring in a layout effect keeps the first paint
	// from showing the unclamped position.
	const [placement, setPlacement] = useState<{
		barSize: { width: number; height: number };
		paneRect: CanvasObstacleRect;
	} | null>(null);
	const measurePlacement = useEventCallback(() => {
		const pane = barEl?.offsetParent;
		if (isMobile || !barEl || !(pane instanceof HTMLElement)) return;

		const bar = barEl.getBoundingClientRect();
		const paneBox = pane.getBoundingClientRect();
		setPlacement((prev) =>
			prev &&
			prev.barSize.width === bar.width &&
			prev.barSize.height === bar.height &&
			prev.paneRect.left === paneBox.left &&
			prev.paneRect.top === paneBox.top &&
			prev.paneRect.right === paneBox.right &&
			prev.paneRect.bottom === paneBox.bottom
				? prev
				: {
						barSize: { width: bar.width, height: bar.height },
						paneRect: {
							left: paneBox.left,
							top: paneBox.top,
							right: paneBox.right,
							bottom: paneBox.bottom,
						},
					},
		);
	});
	// The bar's content swaps with the tool context without resizing its
	// container, so re-measure after every render.
	useLayoutEffect(() => {
		measurePlacement();
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: measurePlacement is stable (useEventCallback)
	useLayoutEffect(() => {
		if (!barEl || isMobile) return;
		const observer = new ResizeObserver(measurePlacement);
		observer.observe(barEl);
		return () => observer.disconnect();
	}, [barEl, isMobile]);

	const dragStateRef = useRef<{
		pointerId: number;
		startClientX: number;
		startClientY: number;
		startOffsetX: number;
		startOffsetY: number;
	} | null>(null);
	const lastTapTimeRef = useRef(0);

	const handleDragPointerDown = useEventCallback((e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();

		const now = Date.now();
		if (now - lastTapTimeRef.current < 300) {
			lastTapTimeRef.current = 0;
			uiState.contextActionsOffset = { x: 0, y: 0 };
			return;
		}
		lastTapTimeRef.current = now;

		e.currentTarget.setPointerCapture(e.pointerId);
		dragStateRef.current = {
			pointerId: e.pointerId,
			startClientX: e.clientX,
			startClientY: e.clientY,
			startOffsetX: uiState.contextActionsOffset.x,
			startOffsetY: uiState.contextActionsOffset.y,
		};
	});

	const handleDragPointerMove = useEventCallback((e: React.PointerEvent) => {
		const state = dragStateRef.current;
		if (!state || state.pointerId !== e.pointerId) return;
		uiState.contextActionsOffset = {
			x: state.startOffsetX + (e.clientX - state.startClientX),
			y: state.startOffsetY + (e.clientY - state.startClientY),
		};
	});

	const handleDragPointerUp = useEventCallback((e: React.PointerEvent) => {
		if (dragStateRef.current?.pointerId !== e.pointerId) return;
		dragStateRef.current = null;
	});

	const barClassName = isMobile
		? twm(
				// Inset past the floating toolbar (its docked side only)
				// instead of centering across the full width, then center
				// within. max-width percentages resolve against the full
				// canvas, so both insets are subtracted explicitly or the
				// bar overflows the inset region.
				"pointer-events-auto absolute top-[max(0.5rem,env(safe-area-inset-top))] mx-auto flex w-fit max-w-[calc(100%-4rem-var(--notch-left,0px)-var(--notch-right,0px))] touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain rounded-md border border-border bg-background px-1 py-0.5 shadow-md *:shrink-0",
				toolbarOnRight
					? "left-[calc(0.5rem+var(--notch-left,0px))] right-[calc(3.5rem+var(--notch-right,0px))]"
					: "left-[calc(3.5rem+var(--notch-left,0px))] right-[calc(0.5rem+var(--notch-right,0px))]",
				barFade.left &&
					barFade.right &&
					"[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]",
				barFade.left &&
					!barFade.right &&
					"[mask-image:linear-gradient(to_right,transparent,black_12px)]",
				!barFade.left &&
					barFade.right &&
					"[mask-image:linear-gradient(to_right,black_calc(100%-12px),transparent)]",
			)
		: "pointer-events-auto absolute flex touch-none items-center gap-1 rounded-md border border-border bg-background px-1 py-0.5 shadow-md";
	const clamped =
		!isMobile && placement
			? clampBarPosition({
					anchor,
					offset: uiSnap.contextActionsOffset,
					barSize: placement.barSize,
					paneRect: placement.paneRect,
					obstacles: Object.values(uiSnap.canvasObstacles).filter(
						(rect) => rect != null,
					),
				})
			: null;
	const barStyle = isMobile
		? undefined
		: {
				left: clamped ? clamped.left : anchor.x + uiSnap.contextActionsOffset.x,
				top: clamped ? clamped.top : anchor.y + uiSnap.contextActionsOffset.y,
				transform: "translate(-50%, -100%)",
				transformOrigin: "center bottom",
			};

	return (
		<div className="pointer-events-none absolute inset-0">
			<div
				data-context-actions-root
				ref={setBarEl}
				className={barClassName}
				style={barStyle}
			>
				{!isMobile && (
					<button
						type="button"
						className="flex h-7 items-center justify-center rounded-sm border-r border-border px-1 text-muted-foreground active:cursor-grabbing"
						aria-label="Move context actions"
						onPointerDown={handleDragPointerDown}
						onPointerMove={handleDragPointerMove}
						onPointerUp={handleDragPointerUp}
						onPointerCancel={handleDragPointerUp}
					>
						<GripVertical size={16} />
					</button>
				)}
				{children}
			</div>
		</div>
	);
}
