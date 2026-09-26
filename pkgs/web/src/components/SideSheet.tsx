import { memo, type ReactNode, useState } from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

export const SideSheet = memo(SideSheetRoot);

/**
 * A non-modal sheet that slides in from a screen edge, carrying `edgeContent`
 * on its inner edge. The sheet stays mounted while closed, so `edgeContent`
 * remains on screen and rests where the closed sheet's edge is.
 */
function SideSheetRoot({
	open,
	side,
	leftOffset = 0,
	rightOffset = 0,
	edgeContent,
	onClose,
	className,
	children,
}: {
	open: boolean;
	side: "left" | "right";
	/** Offset from the left edge (e.g. toolbar rail): px number or CSS length */
	leftOffset?: number | string;
	/** Offset from the right edge (e.g. toolbar rail): px number or CSS length */
	rightOffset?: number | string;
	/** Rendered just outside the sheet's inner edge, visible open or closed */
	edgeContent?: ReactNode;
	onClose: () => void;
	className?: string;
	children: ReactNode;
}) {
	const isLeft = side === "left";
	const [drag, setDrag] = useState<{
		startX: number;
		width: number;
		offset: number;
	} | null>(null);

	const handlePointerDown = useEventCallback((e: React.PointerEvent) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		const sheet = e.currentTarget.parentElement;
		setDrag({
			startX: e.clientX,
			width: sheet?.getBoundingClientRect().width ?? 0,
			offset: 0,
		});
	});

	const handlePointerMove = useEventCallback((e: React.PointerEvent) => {
		if (!drag) return;

		// Only toward the closing edge; the open position is the far end.
		const delta = e.clientX - drag.startX;
		const offset = isLeft
			? Math.max(-drag.width, Math.min(0, delta))
			: Math.min(drag.width, Math.max(0, delta));
		setDrag({ ...drag, offset });
	});

	const handlePointerUp = useEventCallback((e: React.PointerEvent) => {
		if (!drag) return;

		e.currentTarget.releasePointerCapture(e.pointerId);
		setDrag(null);
		if (Math.abs(drag.offset) > drag.width / 3) onClose();
	});

	return (
		// The sheet slides past the surrounding chrome (a toolbar rail) while
		// closed, so this layer stops where that chrome begins and clips it there.
		<div
			style={{ left: leftOffset, right: rightOffset }}
			className="fixed inset-y-0 pointer-events-none overflow-hidden"
		>
			<div
				style={
					drag
						? { transform: `translateX(${drag.offset}px)`, transition: "none" }
						: undefined
				}
				className={twm(
					"absolute top-0 bottom-0 w-64 flex pointer-events-auto border-x border-border",
					"transition-transform duration-300 ease-out",
					isLeft ? "left-0 flex-row" : "right-0 flex-row-reverse",
					!open && (isLeft ? "-translate-x-full" : "translate-x-full"),
					className,
				)}
			>
				<div className="flex-1 min-w-0 flex flex-col">{children}</div>
				<div
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerUp}
					className="w-6 shrink-0 flex items-center justify-center touch-none"
				>
					<div className="h-8 w-1 rounded-full bg-border" />
				</div>
				{edgeContent && (
					<div
						className={twm(
							"absolute top-0",
							isLeft ? "left-full" : "right-full",
						)}
					>
						{edgeContent}
					</div>
				)}
			</div>
		</div>
	);
}
