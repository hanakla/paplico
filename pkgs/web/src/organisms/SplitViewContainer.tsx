"use client";

import { useRef, useState } from "react";
import type { Paplico } from "@/core/Paplico";
import { useEventCallback } from "@/utils/hooks";
import { CanvasPane } from "./CanvasPane";

interface SplitViewContainerProps {
	paplico: Paplico;
	primaryTargetId: string;
	direction?: "horizontal" | "vertical";
}

export function SplitViewContainer({
	paplico,
	primaryTargetId,
	direction = "horizontal",
}: SplitViewContainerProps) {
	const [splitRatio, setSplitRatio] = useState(0.5);
	const containerRef = useRef<HTMLDivElement>(null);
	const isDragging = useRef(false);

	const handleDragStart = useEventCallback((e: React.PointerEvent) => {
		isDragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	});

	const handleDragMove = useEventCallback((e: React.PointerEvent) => {
		if (!isDragging.current || !containerRef.current) return;

		const rect = containerRef.current.getBoundingClientRect();
		const ratio =
			direction === "horizontal"
				? (e.clientX - rect.left) / rect.width
				: (e.clientY - rect.top) / rect.height;

		setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
	});

	const handleDragEnd = useEventCallback(() => {
		isDragging.current = false;
	});

	const isHorizontal = direction === "horizontal";
	const firstSize = `${splitRatio * 100}%`;
	const secondSize = `${(1 - splitRatio) * 100}%`;

	return (
		<div
			ref={containerRef}
			className="w-full h-full flex"
			style={{ flexDirection: isHorizontal ? "row" : "column" }}
		>
			<div style={{ [isHorizontal ? "width" : "height"]: firstSize }}>
				<CanvasPane paplico={paplico} />
			</div>

			{/* Drag handle */}
			<div
				className={`${
					isHorizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
				} bg-border/50 hover:bg-primary/50 transition-colors flex-shrink-0`}
				onPointerDown={handleDragStart}
				onPointerMove={handleDragMove}
				onPointerUp={handleDragEnd}
			/>

			<div style={{ [isHorizontal ? "width" : "height"]: secondSize }}>
				<CanvasPane paplico={paplico} targetId={primaryTargetId} isPrimary />
			</div>
		</div>
	);
}
