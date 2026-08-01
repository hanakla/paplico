"use client";

import { type ReactNode, useRef, useState } from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

type Direction = "top" | "right" | "bottom" | "left";

const isHorizontal = (dir: Direction) => dir === "left" || dir === "right";

const EDGE_CLASSES: Record<Direction, string> = {
	top: "left-0 right-0 top-0 h-1 cursor-row-resize",
	bottom: "left-0 right-0 bottom-0 h-1 cursor-row-resize",
	left: "top-0 bottom-0 left-0 w-1 cursor-col-resize",
	right: "top-0 bottom-0 right-0 w-1 cursor-col-resize",
};

const HANDLE_CLASSES: Record<Direction, string> = {
	top: "left-1/2 -translate-x-1/2 top-0 -translate-y-1/2 w-8 h-1 rounded-full cursor-row-resize",
	bottom:
		"left-1/2 -translate-x-1/2 bottom-0 translate-y-1/2 w-8 h-1 rounded-full cursor-row-resize",
	left: "top-1/2 -translate-y-1/2 left-0 -translate-x-1/2 h-8 w-1 rounded-full cursor-col-resize",
	right:
		"top-1/2 -translate-y-1/2 right-0 translate-x-1/2 h-8 w-1 rounded-full cursor-col-resize",
};

// lint-unused-ignore
export function Resizable({
	dir,
	defaultSize,
	minSize = 80,
	maxSize = 600,
	className,
	onSizeChange,
	children,
}: {
	dir: Direction;
	defaultSize: number;
	minSize?: number;
	maxSize?: number;
	className?: string;
	onSizeChange?: (size: number) => void;
	children: ReactNode;
}) {
	const [size, setSize] = useState(defaultSize);
	const containerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		startPos: number;
		startSize: number;
		sign: number;
	} | null>(null);

	const handlePointerDown = useEventCallback((e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();

		dragRef.current = {
			startPos: isHorizontal(dir) ? e.clientX : e.clientY,
			startSize: size,
			sign: dir === "top" || dir === "left" ? -1 : 1,
		};

		e.currentTarget.setPointerCapture(e.pointerId);
		document.body.style.cursor = isHorizontal(dir)
			? "col-resize"
			: "row-resize";
		document.body.style.userSelect = "none";
	});

	const handlePointerMove = useEventCallback((e: React.PointerEvent) => {
		if (!dragRef.current) return;

		const currentPos = isHorizontal(dir) ? e.clientX : e.clientY;
		const delta =
			(currentPos - dragRef.current.startPos) * dragRef.current.sign;
		const nextSize = Math.max(
			minSize,
			Math.min(maxSize, dragRef.current.startSize + delta),
		);
		setSize(nextSize);
		onSizeChange?.(nextSize);
	});

	const handlePointerUp = useEventCallback((e: React.PointerEvent) => {
		if (!dragRef.current) return;

		dragRef.current = null;
		e.currentTarget.releasePointerCapture(e.pointerId);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	});

	const sizeStyle = isHorizontal(dir) ? { width: size } : { height: size };

	return (
		<div
			ref={containerRef}
			className={twm("relative", className)}
			style={sizeStyle}
		>
			{children}

			<div
				className={`absolute touch-none ${EDGE_CLASSES[dir]} hover:bg-accent/30 active:bg-accent/50 transition-colors`}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			/>

			<div
				className={`absolute touch-none ${HANDLE_CLASSES[dir]} bg-muted-foreground/40 hover:bg-accent/60 active:bg-accent transition-colors`}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			/>
		</div>
	);
}
