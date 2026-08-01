import {
	createContext,
	memo,
	type ReactNode,
	use,
	useEffect,
	useRef,
	useState,
} from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

export const SwipeAction = {
	Root: memo(SwipeActionRoot),
	Content: memo(SwipeActionContent),
	Actions: memo(SwipeActionActions),
	Action: memo(SwipeActionAction),
};

// --- Context ---

type SwipeActionContextValue = {
	translateX: number;
	setTranslateX: (x: number) => void;
	isAnimating: boolean;
	setIsAnimating: (v: boolean) => void;
	isOpen: boolean;
	actionsWidth: number;
	setActionsWidth: (w: number) => void;
	snapTo: (targetX: number) => void;
	contentRef: React.RefObject<HTMLDivElement | null>;
	dragState: React.RefObject<DragState | null>;
	threshold: number;
	disabled: boolean;
};

const SwipeActionContext = createContext<SwipeActionContextValue | null>(null);

function useSwipeActionContext() {
	const ctx = use(SwipeActionContext);
	if (!ctx)
		throw new Error(
			"SwipeAction components must be used within SwipeAction.Root",
		);
	return ctx;
}

// --- Root ---

function SwipeActionRoot({
	children,
	threshold = 0.4,
	className,
	disabled = false,
}: {
	children: ReactNode;
	/** Swipe ratio threshold (0-1) to snap open */
	threshold?: number;
	className?: string;
	disabled?: boolean;
}) {
	const contentRef = useRef<HTMLDivElement>(null);
	const dragState = useRef<DragState | null>(null);
	const [translateX, setTranslateX] = useState(0);
	const [isAnimating, setIsAnimating] = useState(false);
	const [isOpen, setIsOpen] = useState(false);
	const [actionsWidth, setActionsWidth] = useState(0);

	const snapTo = useEventCallback((targetX: number) => {
		setIsAnimating(true);
		setTranslateX(targetX);
		setIsOpen(targetX !== 0);

		const el = ctx.contentRef.current;
		if (!el) return;
		const onEnd = () => {
			setIsAnimating(false);
			el.removeEventListener("transitionend", onEnd);
		};
		el.addEventListener("transitionend", onEnd);
	});

	const ctx: SwipeActionContextValue = {
		translateX,
		setTranslateX,
		isAnimating,
		setIsAnimating,
		isOpen,
		actionsWidth,
		setActionsWidth,
		snapTo,
		contentRef,
		dragState,
		threshold,
		disabled,
	};

	return (
		<SwipeActionContext value={ctx}>
			<div className={twm("relative overflow-hidden", className)}>
				{children}
			</div>
		</SwipeActionContext>
	);
}

// --- Content ---

function SwipeActionContent({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const ctx = useSwipeActionContext();

	const handlePointerDown = useEventCallback((e: React.PointerEvent) => {
		if (ctx.disabled) return;
		if (e.button !== 0) return;

		ctx.dragState.current = {
			startX: e.clientX,
			startY: e.clientY,
			startTranslateX: ctx.translateX,
			isDragging: false,
			pointerId: e.pointerId,
			lastX: e.clientX,
			lastTime: performance.now(),
			velocityX: 0,
		};
	});

	const handlePointerMove = useEventCallback((e: React.PointerEvent) => {
		const state = ctx.dragState.current;
		if (!state) return;

		const dx = e.clientX - state.startX;
		const dy = e.clientY - state.startY;

		if (!state.isDragging) {
			const absDx = Math.abs(dx);
			const absDy = Math.abs(dy);

			if (absDx < 5 && absDy < 5) return;

			if (absDy > absDx) {
				ctx.dragState.current = null;
				return;
			}

			state.isDragging = true;
			ctx.contentRef.current?.setPointerCapture(state.pointerId);
		}

		const now = performance.now();
		const dt = now - state.lastTime;
		if (dt > 0) {
			state.velocityX = (e.clientX - state.lastX) / dt;
		}
		state.lastX = e.clientX;
		state.lastTime = now;

		const rawX = state.startTranslateX + dx;
		const clampedX = Math.min(0, Math.max(-ctx.actionsWidth, rawX));
		ctx.setIsAnimating(false);
		ctx.setTranslateX(clampedX);
	});

	const resolveSnap = useEventCallback(
		(state: DragState, finalClientX: number) => {
			const VELOCITY_THRESHOLD = 0.5;
			const velocity = state.velocityX;
			const currentX = state.startTranslateX + (finalClientX - state.startX);
			const clampedX = Math.min(0, Math.max(-ctx.actionsWidth, currentX));

			if (velocity < -VELOCITY_THRESHOLD) {
				ctx.snapTo(-ctx.actionsWidth);
			} else if (velocity > VELOCITY_THRESHOLD) {
				ctx.snapTo(0);
			} else {
				const progress = Math.abs(clampedX) / ctx.actionsWidth;
				ctx.snapTo(progress > ctx.threshold ? -ctx.actionsWidth : 0);
			}
		},
	);

	const handlePointerUp = useEventCallback((e: React.PointerEvent) => {
		const state = ctx.dragState.current;
		if (!state) return;

		ctx.dragState.current = null;

		if (!state.isDragging) return;

		ctx.contentRef.current?.releasePointerCapture(state.pointerId);

		// Prevent the click event that fires after pointerup from
		// triggering handleContentClick which would close the swipe
		ctx.contentRef.current?.addEventListener(
			"click",
			(ev) => ev.stopPropagation(),
			{ once: true, capture: true },
		);

		resolveSnap(state, e.clientX);
	});

	const handlePointerCancel = useEventCallback((e: React.PointerEvent) => {
		if (ctx.dragState.current) {
			ctx.contentRef.current?.releasePointerCapture(e.pointerId);
			ctx.dragState.current = null;
			ctx.snapTo(ctx.isOpen ? -ctx.actionsWidth : 0);
		}
	});

	const handleLostPointerCapture = useEventCallback(() => {
		if (ctx.dragState.current) {
			const state = ctx.dragState.current;
			ctx.dragState.current = null;
			resolveSnap(state, state.lastX);
		}
	});

	const handleContentClick = useEventCallback(() => {
		if (ctx.isOpen) ctx.snapTo(0);
	});

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: swipe gesture container
		// biome-ignore lint/a11y/useKeyWithClickEvents: swipe gesture container
		<div
			ref={ctx.contentRef}
			className={twm(
				"relative z-10 touch-pan-y",
				ctx.isAnimating && "transition-transform duration-200 ease-out",
				className,
			)}
			style={{ transform: `translateX(${ctx.translateX}px)` }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerCancel}
			onLostPointerCapture={handleLostPointerCapture}
			onClick={handleContentClick}
		>
			{children}
		</div>
	);
}

// --- Actions ---

function SwipeActionActions({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const ctx = useSwipeActionContext();
	const ref = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: setActionsWidth is stable (useEventCallback)
	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const observer = new ResizeObserver(() => {
			ctx.setActionsWidth(el.scrollWidth);
		});
		observer.observe(el);
		ctx.setActionsWidth(el.scrollWidth);

		return () => observer.disconnect();
	}, []);

	const actionsProgress =
		ctx.actionsWidth > 0
			? Math.min(1, Math.abs(ctx.translateX) / ctx.actionsWidth)
			: 0;

	return (
		<div
			ref={ref}
			className={twm(
				"absolute top-0 right-0 bottom-0 flex items-stretch",
				className,
			)}
			style={{ opacity: actionsProgress }}
		>
			{children}
		</div>
	);
}

// --- Action ---

function SwipeActionAction({
	children,
	onClick,
	width = 72,
	className,
}: {
	children: ReactNode;
	onClick: () => void;
	width?: number;
	className?: string;
}) {
	const ctx = useSwipeActionContext();

	const handleClick = useEventCallback(() => {
		ctx.snapTo(0);
		onClick();
	});

	return (
		<button
			type="button"
			onClick={handleClick}
			className={twm(
				"flex items-center justify-center text-xs font-medium",
				className,
			)}
			style={{ width }}
		>
			{children}
		</button>
	);
}

// --- Types ---

type DragState = {
	startX: number;
	startY: number;
	startTranslateX: number;
	isDragging: boolean;
	pointerId: number;
	lastX: number;
	lastTime: number;
	velocityX: number;
};
