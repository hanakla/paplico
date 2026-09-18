import { memo, useRef } from "react";
import type { BlendEasingNode } from "@/core/schema";
import {
	insertBezierEasingNode,
	MIN_NODE_X_GAP,
	sanitizeBezierEasingNodes,
} from "@/core/utils/bezierEasing";
import { clamp } from "@/core/utils/math";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

/**
 * Editor for an easing curve made of cubic Bézier segments over x in 0..1.
 *
 * Nodes and handles follow the pen-tool conventions: dragging a handle keeps
 * the opposite one on the same line, and Alt-dragging breaks them apart into
 * a corner. Clicking the plot adds a node on the curve, and a node dragged off
 * the plot or double-clicked is removed, the same as CurveEditor. The end
 * nodes stay at (0, 0) and (1, 1). A node dragged past its neighbor swaps
 * order with it. The curve may leave the 0..1 band vertically.
 */
export const BezierCurveEditor = memo(function BezierCurveEditor({
	value,
	onChange,
	label,
	className,
}: {
	value: readonly BlendEasingNode[];
	onChange: (nodes: BlendEasingNode[]) => void;
	label: string;
	className?: string;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const draggingRef = useRef<Drag | null>(null);
	// A node inserted by pointerdown must not be removed by the dblclick that
	// the same double-tap on the background would otherwise trigger.
	const suppressDoubleClickRef = useRef(false);

	const lastIndex = value.length - 1;

	const fromClient = (
		e: { clientX: number; clientY: number },
		rect: DOMRect,
	) => {
		const svgX = ((e.clientX - rect.left) / rect.width) * SVG_WIDTH;
		const svgY = ((e.clientY - rect.top) / rect.height) * SVG_HEIGHT;
		return {
			x: clamp((svgX - PAD) / PLOT_WIDTH, 0, 1),
			y: clamp(fromSvgY(svgY), MIN_Y, MAX_Y),
			svgX,
			svgY,
		};
	};

	/**
	 * Handles win over nodes: a short handle sits close to its node and would
	 * never be reachable if the node won ties.
	 */
	const hitTest = (svgX: number, svgY: number): Drag | null => {
		const handles = value.flatMap((node, index): Target[] => [
			...(index > 0 && (node.inX !== 0 || node.inY !== 0)
				? [
						{
							x: node.x + node.inX,
							y: node.y + node.inY,
							drag: { kind: "handle", index, side: "in" } as const,
						},
					]
				: []),
			...(index < lastIndex && (node.outX !== 0 || node.outY !== 0)
				? [
						{
							x: node.x + node.outX,
							y: node.y + node.outY,
							drag: { kind: "handle", index, side: "out" } as const,
						},
					]
				: []),
		]);
		const nodes = value.map(
			(node, index): Target => ({
				x: node.x,
				y: node.y,
				drag: { kind: "node", index, removed: null },
			}),
		);
		return nearest(handles, svgX, svgY) ?? nearest(nodes, svgX, svgY);
	};

	/** Place `moved` among the other nodes and report where it landed. */
	const commitNode = (
		others: readonly BlendEasingNode[],
		moved: BlendEasingNode,
	): number => {
		const sorted = [...others, moved].sort((a, b) => a.x - b.x);
		onChange(sanitizeBezierEasingNodes(sorted));
		return sorted.indexOf(moved);
	};

	const handlePointerDown = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			if (draggingRef.current) return;
			const svg = svgRef.current;
			if (!svg) return;

			const pos = fromClient(e, svg.getBoundingClientRect());
			const hit = hitTest(pos.svgX, pos.svgY);
			suppressDoubleClickRef.current = false;

			if (hit) {
				draggingRef.current = hit;
				svg.setPointerCapture(e.pointerId);
				return;
			}

			const inserted = insertBezierEasingNode(
				value,
				clamp(pos.x, MIN_NODE_X_GAP, 1 - MIN_NODE_X_GAP),
			);
			suppressDoubleClickRef.current = true;
			onChange(sanitizeBezierEasingNodes(inserted.nodes));
			draggingRef.current = {
				kind: "node",
				index: inserted.index,
				removed: null,
			};
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

			if (drag.kind === "handle") {
				onChange(
					sanitizeBezierEasingNodes(
						value.map((node, i) =>
							i === drag.index
								? moveHandle(node, drag.side, pos, e.altKey)
								: node,
						),
					),
				);
				return;
			}

			if (drag.index === 0 || drag.index === lastIndex) return;

			const isFarOutside =
				e.clientX < rect.left - REMOVE_DISTANCE_PX ||
				e.clientX > rect.right + REMOVE_DISTANCE_PX ||
				e.clientY < rect.top - REMOVE_DISTANCE_PX ||
				e.clientY > rect.bottom + REMOVE_DISTANCE_PX;
			const x = clamp(pos.x, MIN_NODE_X_GAP, 1 - MIN_NODE_X_GAP);

			if (drag.removed) {
				// Hidden while outside; re-inserted when the pointer comes back.
				if (isFarOutside) return;
				drag.index = commitNode(value, { ...drag.removed, x, y: pos.y });
				drag.removed = null;
				return;
			}

			if (isFarOutside) {
				drag.removed = value[drag.index];
				onChange(value.filter((_, i) => i !== drag.index));
				return;
			}

			drag.index = commitNode(
				value.filter((_, i) => i !== drag.index),
				{ ...value[drag.index], x, y: pos.y },
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
			const hit = hitTest(pos.svgX, pos.svgY);
			if (hit?.kind !== "node" || hit.index <= 0 || hit.index >= lastIndex) {
				return;
			}
			onChange(value.filter((_, i) => i !== hit.index));
		},
	);

	const curvePath = value
		.slice(1)
		.map((b, i) => {
			const a = value[i];
			return `C ${toSvgX(a.x + a.outX)},${toSvgY(a.y + a.outY)} ${toSvgX(b.x + b.inX)},${toSvgY(b.y + b.inY)} ${toSvgX(b.x)},${toSvgY(b.y)}`;
		})
		.join(" ");

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
			<g className="stroke-border/50">
				{[0.25, 0.5, 0.75].map((x) => (
					<line
						key={x}
						x1={toSvgX(x)}
						y1={toSvgY(MAX_Y)}
						x2={toSvgX(x)}
						y2={toSvgY(MIN_Y)}
					/>
				))}
				<line x1={toSvgX(0)} y1={toSvgY(0.5)} x2={toSvgX(1)} y2={toSvgY(0.5)} />
			</g>
			<rect
				x={PAD}
				y={PAD}
				width={PLOT_WIDTH}
				height={PLOT_HEIGHT}
				className="fill-none stroke-border/50"
			/>

			{/* The band the keys span: y = 0 is the first key, y = 1 the next */}
			{[0, 1].map((y) => (
				<line
					key={y}
					x1={toSvgX(0)}
					y1={toSvgY(y)}
					x2={toSvgX(1)}
					y2={toSvgY(y)}
					className="stroke-border"
				/>
			))}

			<line
				x1={toSvgX(0)}
				y1={toSvgY(0)}
				x2={toSvgX(1)}
				y2={toSvgY(1)}
				strokeDasharray="3 3"
				className="stroke-muted-foreground/50"
			/>

			<path
				d={`M ${toSvgX(value[0].x)},${toSvgY(value[0].y)} ${curvePath}`}
				strokeWidth={1.5}
				className="fill-none stroke-accent"
			/>

			{value.map((node, index) => (
				<g
					// biome-ignore lint/suspicious/noArrayIndexKey: nodes have no identity and are re-sorted on every edit
					key={index}
					className="stroke-accent"
				>
					{index > 0 && <HandleMark node={node} dx={node.inX} dy={node.inY} />}
					{index < lastIndex && (
						<HandleMark node={node} dx={node.outX} dy={node.outY} />
					)}
				</g>
			))}

			{value.map((node, index) => (
				<circle
					// biome-ignore lint/suspicious/noArrayIndexKey: nodes have no identity and are re-sorted on every edit
					key={index}
					cx={toSvgX(node.x)}
					cy={toSvgY(node.y)}
					r={4}
					strokeWidth={1.5}
					className="fill-accent stroke-background"
				/>
			))}
		</svg>
	);
});

type Drag =
	| { kind: "node"; index: number; removed: BlendEasingNode | null }
	| { kind: "handle"; index: number; side: "in" | "out" };

type Target = { x: number; y: number; drag: Drag };

const SVG_WIDTH = 200;
const SVG_HEIGHT = 200;
const PAD = 8;
const PLOT_WIDTH = SVG_WIDTH - PAD * 2;
const PLOT_HEIGHT = SVG_HEIGHT - PAD * 2;
const MIN_Y = -0.5;
const MAX_Y = 1.5;
const HIT_RADIUS = 10;
const REMOVE_DISTANCE_PX = 24;
/** Sine of the angle under which the two handles still count as one line. */
const SMOOTH_TOLERANCE = 1e-3;

function HandleMark({
	node,
	dx,
	dy,
}: {
	node: BlendEasingNode;
	dx: number;
	dy: number;
}) {
	return (
		<>
			<line
				x1={toSvgX(node.x)}
				y1={toSvgY(node.y)}
				x2={toSvgX(node.x + dx)}
				y2={toSvgY(node.y + dy)}
				strokeWidth={1}
			/>
			<circle
				cx={toSvgX(node.x + dx)}
				cy={toSvgY(node.y + dy)}
				r={3}
				strokeWidth={1.5}
				className="fill-background"
			/>
		</>
	);
}

function nearest(
	targets: readonly Target[],
	svgX: number,
	svgY: number,
): Drag | null {
	let best: Drag | null = null;
	let bestDistance = HIT_RADIUS;
	for (const target of targets) {
		const distance = Math.hypot(
			toSvgX(target.x) - svgX,
			toSvgY(target.y) - svgY,
		);
		if (distance > bestDistance) continue;
		bestDistance = distance;
		best = target.drag;
	}
	return best;
}

/**
 * Point one handle at `pos`, keeping it on its own side of the node. Unless
 * Alt is held, a node whose handles are on one line keeps them there: the
 * opposite handle turns to face away and keeps its length.
 */
function moveHandle(
	node: BlendEasingNode,
	side: "in" | "out",
	pos: { x: number; y: number },
	breakApart: boolean,
): BlendEasingNode {
	const dx =
		side === "out" ? Math.max(pos.x - node.x, 0) : Math.min(pos.x - node.x, 0);
	const dy = pos.y - node.y;
	const moved =
		side === "out"
			? { ...node, outX: dx, outY: dy }
			: { ...node, inX: dx, inY: dy };

	const length = Math.hypot(dx, dy);
	if (breakApart || length === 0 || !isSmooth(node)) return moved;

	const [ox, oy] =
		side === "out" ? [node.inX, node.inY] : [node.outX, node.outY];
	const oppositeLength = Math.hypot(ox, oy);
	const opposite = {
		x: (-dx / length) * oppositeLength,
		y: (-dy / length) * oppositeLength,
	};
	return side === "out"
		? { ...moved, inX: opposite.x, inY: opposite.y }
		: { ...moved, outX: opposite.x, outY: opposite.y };
}

/** True when the two handles point in opposite directions along one line. */
function isSmooth(node: BlendEasingNode): boolean {
	const inLength = Math.hypot(node.inX, node.inY);
	const outLength = Math.hypot(node.outX, node.outY);
	if (inLength === 0 || outLength === 0) return true;
	const cross = node.inX * node.outY - node.inY * node.outX;
	const dot = node.inX * node.outX + node.inY * node.outY;
	return dot < 0 && Math.abs(cross) <= SMOOTH_TOLERANCE * inLength * outLength;
}

function toSvgX(x: number): number {
	return PAD + x * PLOT_WIDTH;
}

function toSvgY(y: number): number {
	return SVG_HEIGHT - PAD - ((y - MIN_Y) / (MAX_Y - MIN_Y)) * PLOT_HEIGHT;
}

function fromSvgY(svgY: number): number {
	return ((SVG_HEIGHT - PAD - svgY) / PLOT_HEIGHT) * (MAX_Y - MIN_Y) + MIN_Y;
}
