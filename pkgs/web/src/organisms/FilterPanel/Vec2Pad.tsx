import type { PointerEvent } from "react";
import { useEventCallback } from "@/utils/hooks";

/**
 * 2D drag pad over a normalized 0-1 square: top-left = (0,0), bottom-right
 * = (1,1), matching the shaders' texCoord orientation. Callers map their
 * own domain (e.g. a -1..1 direction vector) onto the 0-1 pad space.
 */
export function Vec2Pad({
	x,
	y,
	onChange,
}: {
	x: number;
	y: number;
	onChange: (x: number, y: number) => void;
}) {
	const handlePoint = useEventCallback((e: PointerEvent<HTMLDivElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		onChange(
			clamp01((e.clientX - rect.left) / rect.width),
			clamp01((e.clientY - rect.top) / rect.height),
		);
	});
	const handlePointerDown = useEventCallback(
		(e: PointerEvent<HTMLDivElement>) => {
			e.currentTarget.setPointerCapture(e.pointerId);
			handlePoint(e);
		},
	);
	const handlePointerMove = useEventCallback(
		(e: PointerEvent<HTMLDivElement>) => {
			if (e.buttons & 1) handlePoint(e);
		},
	);

	return (
		<div
			className="relative aspect-square w-full touch-none select-none rounded border border-border bg-foreground/5"
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
		>
			<div className="absolute inset-y-0 left-1/2 w-px bg-foreground/20" />
			<div className="absolute inset-x-0 top-1/2 h-px bg-foreground/20" />
			<div
				className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow"
				style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
			/>
		</div>
	);
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}
