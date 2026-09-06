import { Slider as BUISlider } from "@base-ui/react/slider";
import { memo, useEffect, useRef, useState } from "react";
import { tv, type VariantProps } from "tailwind-variants";
import { useEventCallback } from "@/utils/hooks";
import type { PropsWithNativeClassName } from "./types";

export const Slider = memo(SliderRoot) as typeof SliderRoot;

export namespace Slider {
	export type Props<T extends number | readonly number[]> = SliderProps<T>;
}

export const InfiniteSlider = memo(InfiniteSliderRoot);

const sliderVariants = tv({
	slots: {
		root: "relative flex touch-none select-none data-disabled:opacity-40 data-disabled:pointer-events-none",
		control: "flex items-center justify-center",
		track: "relative grow rounded-full bg-foreground/20",
		indicator: "absolute rounded-full bg-accent",
		thumb:
			"block rounded-full bg-accent shadow cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
	},
	variants: {
		orientation: {
			horizontal: {
				root: "w-full items-center",
				control: "w-full h-full",
				indicator: "h-full left-0",
			},
			vertical: {
				root: "w-6 flex-col items-center",
				control: "w-full h-full flex-col",
				track: "w-1 h-full",
				indicator: "w-full bottom-0",
			},
		},
		$size: {
			sm: {
				root: "h-4",
				track: "h-1",
				thumb: "size-3 drop-shadow-sm drop-shadow-black/50",
			},
			lg: {
				root: "h-8",
				track: "h-2",
				thumb: "size-4 drop-shadow-sm drop-shadow-black/50",
			},
		},
		animateThumb: {
			true: { thumb: "transition-[left,transform] duration-200 ease-out" },
		},
	},
	defaultVariants: {
		orientation: "horizontal",
		$size: "sm",
	},
});

type SliderProps<T extends number | readonly number[]> =
	PropsWithNativeClassName<Omit<BUISlider.Root.Props<T>, "children">> & {
		orientation?: VariantProps<typeof sliderVariants>["orientation"];
		$size?: VariantProps<typeof sliderVariants>["$size"];
		value?: T;
		hideThumb?: boolean;
		/** Animate the thumb's position with a CSS transition (for programmatic snap-back, not live dragging) */
		animateThumb?: boolean;
	};

function SliderRoot<T extends number | readonly number[]>({
	className,
	orientation = "horizontal",
	$size = "sm",
	value,
	hideThumb,
	animateThumb,
	...props
}: SliderProps<T>) {
	const styles = sliderVariants({ orientation, $size, animateThumb });
	// Range sliders (array values) need one thumb per value
	const resolvedValue = value ?? props.defaultValue;
	const thumbCount = Array.isArray(resolvedValue) ? resolvedValue.length : 1;

	return (
		<BUISlider.Root<T>
			className={styles.root({ className })}
			orientation={orientation}
			value={value}
			{...props}
		>
			<BUISlider.Control className={styles.control()}>
				<BUISlider.Track className={styles.track()}>
					<BUISlider.Indicator className={styles.indicator()} />
					{!hideThumb &&
						Array.from({ length: thumbCount }, (_, index) => (
							<BUISlider.Thumb
								key={index}
								className={styles.thumb()}
								aria-label={props["aria-label"]}
								aria-labelledby={props["aria-labelledby"]}
							/>
						))}
				</BUISlider.Track>
			</BUISlider.Control>
		</BUISlider.Root>
	);
}

/** 190 BPM beat duration (ms) — the thumb's release-position hold, and its return-to-rest animation, each last one beat of this. */
const RELEASE_HOLD_MS = 60_000 / 190;

/**
 * A slider whose visible window (-range..+range) is a drag delta, not the
 * absolute value: dragging fires `onValueChange` continuously against a
 * value pinned at drag start, then the thumb snaps back to a rest position
 * that leans toward the nearer end as the value approaches min/max.
 */
function InfiniteSliderRoot({
	value,
	min,
	max,
	range,
	step,
	onValueChange,
	onDragEnd,
	className,
	$size = "sm",
}: {
	value: number;
	min: number;
	max: number;
	/** Half-width of the visible window, e.g. 100 for a -100..+100 track */
	range: number;
	step: number;
	onValueChange: (value: number) => void;
	/** Fires once the drag is released (after the final onValueChange), for consumers that pin their own drag-start state. */
	onDragEnd?: () => void;
	className?: string;
	$size?: VariantProps<typeof sliderVariants>["$size"];
}) {
	const restPosition = computeInfiniteSliderRestPosition(
		value,
		min,
		max,
		range,
	);
	const [dragPosition, setDragPosition] = useState<number | null>(null);
	// Value pinned at drag start: `value` itself moves live as onValueChange
	// fires, so the delta must be computed against a fixed base, not the
	// latest (already-updated) value.
	const dragStartValueRef = useRef<number | null>(null);
	// The thumb's on-screen position at drag start (see `restPosition`) is
	// where BUISlider's internal -range..+range track starts counting from,
	// NOT necessarily 0 — e.g. near `min` it sits at -range. Without
	// subtracting this, dragging from a leaned-in thumb ignores the first
	// `restPosition`..0 stretch of the track (its raw values land below
	// `min` and get clamped to the same starting value).
	const dragStartRestPositionRef = useRef<number | null>(null);
	// Delays the post-release snap-back so the thumb visibly pauses at the
	// release position first (see handleValueCommitted).
	const releaseHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	const handleValueChange = useEventCallback((val: number) => {
		if (releaseHoldTimerRef.current != null) {
			clearTimeout(releaseHoldTimerRef.current);
			releaseHoldTimerRef.current = null;
		}
		dragStartValueRef.current ??= value;
		dragStartRestPositionRef.current ??= restPosition;
		setDragPosition(val);
		onValueChange(
			computeInfiniteSliderValue(
				dragStartValueRef.current,
				dragStartRestPositionRef.current,
				val,
				min,
				max,
			),
		);
	});

	const handleValueCommitted = useEventCallback((val: number) => {
		if (
			dragStartValueRef.current != null &&
			dragStartRestPositionRef.current != null
		) {
			onValueChange(
				computeInfiniteSliderValue(
					dragStartValueRef.current,
					dragStartRestPositionRef.current,
					val,
					min,
					max,
				),
			);
		}
		dragStartValueRef.current = null;
		dragStartRestPositionRef.current = null;
		// Hold the thumb at the release position for one triplet beat, then
		// clear dragPosition so it animates back to rest over the next beat.
		setDragPosition(val);
		releaseHoldTimerRef.current = setTimeout(() => {
			releaseHoldTimerRef.current = null;
			setDragPosition(null);
		}, RELEASE_HOLD_MS);
		onDragEnd?.();
	});

	useEffect(() => {
		return () => {
			if (releaseHoldTimerRef.current != null) {
				clearTimeout(releaseHoldTimerRef.current);
			}
		};
	}, []);

	const styles = sliderVariants({ $size, animateThumb: dragPosition == null });
	const restPositionPercent = ((restPosition + range) / (2 * range)) * 100;

	return (
		<BUISlider.Root
			className={styles.root({ className })}
			min={-range}
			max={range}
			step={step}
			value={dragPosition ?? restPosition}
			onValueChange={handleValueChange}
			onValueCommitted={handleValueCommitted}
		>
			<BUISlider.Control className={styles.control()}>
				<BUISlider.Track className={styles.track()}>
					<div
						aria-hidden
						className="absolute inset-0 rounded-full pointer-events-none"
						style={{
							background: `radial-gradient(circle at ${restPositionPercent}% 50%, var(--color-accent) 0%, transparent 70%)`,
						}}
					/>
					<BUISlider.Thumb
						className={styles.thumb()}
						style={
							dragPosition == null
								? { transitionDuration: `${RELEASE_HOLD_MS}ms` }
								: undefined
						}
					/>
				</BUISlider.Track>
			</BUISlider.Control>
		</BUISlider.Root>
	);
}

/**
 * Thumb rest position within the -range..+range track: centered while
 * `value` has at least `range` of room from both `min` and `max`, otherwise
 * leaning toward the nearer end (e.g. `-range` once `value` reaches `min`).
 */
export function computeInfiniteSliderRestPosition(
	value: number,
	min: number,
	max: number,
	range: number,
): number {
	const distFromMin = value - min;
	const distFromMax = max - value;
	return distFromMin < range
		? distFromMin - range
		: distFromMax < range
			? range - distFromMax
			: 0;
}

/**
 * External value for a raw -range..+range track reading. Measured from the
 * thumb's rest position at drag start, not from track-0 — a thumb leaning
 * toward `min` starts at `-range`, so the delta must be `trackValue -
 * dragStartRestPosition`, not `trackValue` itself, or the first
 * `dragStartRestPosition`..0 stretch of the drag reads as still-clamped-to-min.
 */
export function computeInfiniteSliderValue(
	dragStartValue: number,
	dragStartRestPosition: number,
	trackValue: number,
	min: number,
	max: number,
): number {
	return Math.min(
		max,
		Math.max(min, dragStartValue + (trackValue - dragStartRestPosition)),
	);
}
