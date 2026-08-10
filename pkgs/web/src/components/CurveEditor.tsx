import { memo, useRef } from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

/**
 * Point-and-drag editor for a piecewise curve over x in 0..1.
 *
 * The pressure curve in preferences and every brush property's response curve
 * are the same interaction — drag a point, click the line to insert one, drag
 * it off the plot or double-click it to remove — so they share this. The
 * caller supplies the interpolation used to draw the line so the plot always
 * matches whatever will run at draw time.
 *
 * `yRange` widens the vertical axis for curves whose output is signed (a size
 * offset can subtract as well as add); the identity diagonal is only drawn
 * when the axes mean the same thing.
 */
export type CurvePoint = { x: number; y: number };

const SVG_WIDTH = 200;
const SVG_HEIGHT = 160;
const PAD = 8;
const PLOT_WIDTH = SVG_WIDTH - PAD * 2;
const PLOT_HEIGHT = SVG_HEIGHT - PAD * 2;
const CURVE_SAMPLES = 64;
const HIT_RADIUS = 12;
const REMOVE_DISTANCE_PX = 24;
const NEIGHBOR_X_GAP = 0.01;

export const CurveEditor = memo(function CurveEditor({
	value,
	onChange,
	evaluate,
	yRange = [0, 1],
	label,
	showIdentity = true,
	className,
}: {
	value: readonly CurvePoint[];
	onChange: (points: CurvePoint[]) => void;
	/** Same interpolation the runtime uses, so the plotted line is honest. */
	evaluate: (points: readonly CurvePoint[], x: number) => number;
	yRange?: readonly [number, number];
	label: string;
	showIdentity?: boolean;
	className?: string;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const draggingRef = useRef<{ index: number; removed: boolean } | null>(null);
	// A point inserted by pointerdown must not be removed by the dblclick that
	// the same double-tap on the background would otherwise trigger.
	const suppressDoubleClickRef = useRef(false);

	const [minY, maxY] = yRange;
	const toSvgX = (x: number) => PAD + x * PLOT_WIDTH;
	const toSvgY = (y: number) =>
		SVG_HEIGHT - PAD - ((y - minY) / (maxY - minY)) * PLOT_HEIGHT;

	const fromClient = (
		e: { clientX: number; clientY: number },
		rect: DOMRect,
	) => {
		const svgX = ((e.clientX - rect.left) / rect.width) * SVG_WIDTH;
		const svgY = ((e.clientY - rect.top) / rect.height) * SVG_HEIGHT;
		const y = ((SVG_HEIGHT - PAD - svgY) / PLOT_HEIGHT) * (maxY - minY) + minY;
		return {
			x: clamp((svgX - PAD) / PLOT_WIDTH, 0, 1),
			y: clamp(y, minY, maxY),
			svgX,
			svgY,
		};
	};

	const hitTest = (svgX: number, svgY: number): number => {
		let bestIndex = -1;
		let bestDistance = HIT_RADIUS;
		value.forEach((point, i) => {
			const distance = Math.hypot(
				toSvgX(point.x) - svgX,
				toSvgY(point.y) - svgY,
			);
			if (distance <= bestDistance) {
				bestDistance = distance;
				bestIndex = i;
			}
		});
		return bestIndex;
	};

	/** Endpoints move on y only; an interior point stays between its neighbours. */
	const clampDragged = (index: number, pos: CurvePoint): CurvePoint => {
		if (index === 0) return { x: 0, y: pos.y };
		if (index === value.length - 1) return { x: 1, y: pos.y };
		const min = value[index - 1].x + NEIGHBOR_X_GAP;
		const max = value[index + 1].x - NEIGHBOR_X_GAP;
		return { x: clamp(pos.x, min, max), y: pos.y };
	};

	const handlePointerDown = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			if (draggingRef.current) return;
			const svg = svgRef.current;
			if (!svg) return;

			const pos = fromClient(e, svg.getBoundingClientRect());
			const hitIndex = hitTest(pos.svgX, pos.svgY);
			suppressDoubleClickRef.current = false;

			if (hitIndex >= 0) {
				draggingRef.current = { index: hitIndex, removed: false };
				svg.setPointerCapture(e.pointerId);
				return;
			}

			const inserted = {
				x: clamp(pos.x, NEIGHBOR_X_GAP, 1 - NEIGHBOR_X_GAP),
				y: evaluate(value, pos.x),
			};
			const next = [...value, inserted].sort((a, b) => a.x - b.x);
			suppressDoubleClickRef.current = true;
			onChange(next);
			draggingRef.current = { index: next.indexOf(inserted), removed: false };
			svg.setPointerCapture(e.pointerId);
		},
	);

	const handlePointerMove = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			const drag = draggingRef.current;
			const svg = svgRef.current;
			if (!drag || !svg) return;

			const rect = svg.getBoundingClientRect();
			const pos = fromClient(e, rect);
			const isFarOutside =
				e.clientX < rect.left - REMOVE_DISTANCE_PX ||
				e.clientX > rect.right + REMOVE_DISTANCE_PX ||
				e.clientY < rect.top - REMOVE_DISTANCE_PX ||
				e.clientY > rect.bottom + REMOVE_DISTANCE_PX;

			if (drag.removed) {
				// Hidden while outside; re-inserted when the pointer comes back.
				if (isFarOutside) return;
				const restored = {
					x: clamp(pos.x, NEIGHBOR_X_GAP, 1 - NEIGHBOR_X_GAP),
					y: pos.y,
				};
				const next = [...value, restored].sort((a, b) => a.x - b.x);
				drag.index = next.indexOf(restored);
				drag.removed = false;
				onChange(next);
				return;
			}

			const isEndpoint = drag.index === 0 || drag.index === value.length - 1;
			if (isFarOutside && !isEndpoint) {
				drag.removed = true;
				onChange(value.filter((_, i) => i !== drag.index));
				return;
			}

			onChange(
				value.map((point, i) =>
					i === drag.index ? clampDragged(drag.index, pos) : point,
				),
			);
		},
	);

	const handlePointerUp = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			const svg = svgRef.current;
			if (svg?.hasPointerCapture(e.pointerId)) {
				svg.releasePointerCapture(e.pointerId);
			}
			draggingRef.current = null;
		},
	);

	const handleDoubleClick = useEventCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			if (suppressDoubleClickRef.current) {
				suppressDoubleClickRef.current = false;
				return;
			}
			const svg = svgRef.current;
			if (!svg) return;

			const pos = fromClient(e, svg.getBoundingClientRect());
			const hitIndex = hitTest(pos.svgX, pos.svgY);
			if (hitIndex <= 0 || hitIndex >= value.length - 1) return;
			onChange(value.filter((_, i) => i !== hitIndex));
		},
	);

	const curvePath = Array.from({ length: CURVE_SAMPLES }, (_, i) => {
		const x = i / (CURVE_SAMPLES - 1);
		return `${toSvgX(x)},${toSvgY(evaluate(value, x))}`;
	}).join(" ");

	return (
		<svg
			ref={svgRef}
			width={SVG_WIDTH}
			height={SVG_HEIGHT}
			viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
			role="img"
			aria-label={label}
			className={twm(
				"touch-none cursor-crosshair select-none rounded border border-border/40 bg-background/50",
				className,
			)}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onDoubleClick={handleDoubleClick}
		>
			<title>{label}</title>
			{[0.25, 0.5, 0.75].map((step) => (
				<g key={step} className="stroke-border/50">
					<line
						x1={toSvgX(step)}
						y1={toSvgY(maxY)}
						x2={toSvgX(step)}
						y2={toSvgY(minY)}
					/>
					<line
						x1={toSvgX(0)}
						y1={toSvgY(minY + (maxY - minY) * step)}
						x2={toSvgX(1)}
						y2={toSvgY(minY + (maxY - minY) * step)}
					/>
				</g>
			))}
			<rect
				x={PAD}
				y={PAD}
				width={PLOT_WIDTH}
				height={PLOT_HEIGHT}
				className="fill-none stroke-border/50"
			/>

			{/* Zero line, where the axis spans negative values */}
			{minY < 0 && (
				<line
					x1={toSvgX(0)}
					y1={toSvgY(0)}
					x2={toSvgX(1)}
					y2={toSvgY(0)}
					className="stroke-border"
				/>
			)}

			{showIdentity && (
				<line
					x1={toSvgX(0)}
					y1={toSvgY(minY)}
					x2={toSvgX(1)}
					y2={toSvgY(maxY)}
					strokeDasharray="3 3"
					className="stroke-muted-foreground/50"
				/>
			)}

			<polyline
				points={curvePath}
				strokeWidth={1.5}
				className="fill-none stroke-accent"
			/>

			{value.map((point, i) => (
				<circle
					key={`${point.x}:${i}`}
					cx={toSvgX(point.x)}
					cy={toSvgY(point.y)}
					r={4}
					strokeWidth={1.5}
					className="fill-accent stroke-background"
				/>
			))}
		</svg>
	);
});

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
