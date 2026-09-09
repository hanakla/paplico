import { useEffect, useState } from "react";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

export function ShiftButtonOverlay({ className }: { className?: string }) {
	const paplico = usePaplicoMaybe();
	const [pressed, setPressed] = useState(false);

	const handlePointerDown = useEventCallback((e: React.PointerEvent) => {
		e.stopPropagation();
		e.preventDefault();
		(e.target as Element).setPointerCapture(e.pointerId);

		setPressed(true);
		paplico?.ui?.setVirtualShiftKey(true);
	});

	const handlePointerUp = useEventCallback((e: React.PointerEvent) => {
		e.stopPropagation();
		e.preventDefault();
		(e.target as Element).releasePointerCapture(e.pointerId);

		setPressed(false);
		paplico?.ui?.setVirtualShiftKey(false);
	});

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Shift") setPressed(true);
		};
		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.key === "Shift") setPressed(false);
		};
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
		};
	}, []);

	return (
		<button
			type="button"
			className={twm(
				"flex items-center justify-center size-18",
				"rounded-full text-base backdrop-liquid drop-shadow-md transition-all duration-150 select-none touch-none pointer-events-auto",
				"outline-4 outline-offset-0 outline-transparent",
				pressed
					? "bg-virtual-shiftkey text-virtual-shiftkey-foreground/60 outline-virtual-shiftkey outline-offset-4"
					: "bg-virtual-shiftkey text-virtual-shiftkey-foreground/60 hover:bg-virtual-shiftkey-hover",
				className,
			)}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
		>
			SHIFT
		</button>
	);
}
