"use client";

import { Paplico } from "@paplico/core";
import { LoaderCircle, MonitorX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getBuiltinProfileBytes } from "@/infra/builtinIccProfiles";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

const FALLBACK_FONT_URL = "/assets/fonts/NotoSansJP-VariableFont_wght.ttf";

/** The demo the visitor last pressed inside; only it receives shortcuts. */
let activeRoot: HTMLElement | null = null;

type BootState = "idle" | "booting" | "ready" | "unsupported" | "failed";

/**
 * A real Paplico engine mounted on a canvas, booted the first time it scrolls
 * near the viewport. Several of these share one page, so each one only takes
 * keyboard shortcuts after the visitor last pressed inside it, and plain wheel
 * scrolling goes to the page instead of zooming the canvas.
 */
export function LiveCanvas({
	onReady,
	className,
	hint,
}: {
	onReady?: (paplico: Paplico) => void | Promise<void>;
	className?: string;
	hint?: React.ReactNode;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [state, setState] = useState<BootState>("idle");
	const [touched, setTouched] = useState(false);
	const handleReady = useEventCallback(async (paplico: Paplico) => {
		await onReady?.(paplico);
	});

	useEffect(() => {
		const root = rootRef.current;
		const canvas = canvasRef.current;
		if (!root || !canvas) return;

		let paplico: Paplico | null = null;
		let disposed = false;

		const boot = async () => {
			if (!navigator.gpu) {
				setState("unsupported");
				return;
			}

			setState("booting");
			try {
				const instance = await Paplico.create(canvas, {
					fontLoaders: [],
					fallbackFontUrl: FALLBACK_FONT_URL,
					getBuiltinProfileBytes,
					filterShortcutEvents: () => (activeRoot === root ? undefined : false),
				});
				if (disposed) {
					instance.destroy();
					return;
				}
				paplico = instance;
				instance.startRendering();
				instance.tools.setCurrentTool("pen");
				await handleReady(instance);
				setState("ready");
			} catch (error) {
				console.error(error);
				setState(navigator.gpu ? "failed" : "unsupported");
			}
		};

		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				observer.disconnect();
				void boot();
			},
			{ rootMargin: "200px" },
		);
		observer.observe(root);

		return () => {
			disposed = true;
			observer.disconnect();
			if (activeRoot === root) activeRoot = null;
			paplico?.destroy();
		};
	}, [handleReady]);

	const handlePointerDown = () => {
		activeRoot = rootRef.current;
		setTouched(true);
	};

	// Capture phase runs before the canvas' own wheel listener, so stopping it
	// here keeps the page scrolling; pinch gestures arrive with ctrlKey and
	// still reach the canvas as zoom.
	const handleWheelCapture = (event: React.WheelEvent) => {
		if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
	};

	return (
		<div
			ref={rootRef}
			className={twm("aero-canvas relative overflow-hidden", className)}
			onPointerDownCapture={handlePointerDown}
			onWheelCapture={handleWheelCapture}
		>
			<canvas
				ref={canvasRef}
				className="absolute inset-0 size-full touch-none"
			/>
			{state === "ready" && hint && !touched && (
				<div className="aero-hint pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit">
					{hint}
				</div>
			)}
			{(state === "idle" || state === "booting") && (
				<div className="absolute inset-0 grid place-items-center text-sm text-sky-900/70">
					<span className="flex items-center gap-2">
						<LoaderCircle className="size-4 animate-spin" />
						Starting the engine…
					</span>
				</div>
			)}
			{(state === "unsupported" || state === "failed") && (
				<div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-sky-950/80">
					<div className="flex max-w-xs flex-col items-center gap-2">
						<MonitorX className="size-6" />
						<p className="font-semibold">
							{state === "unsupported"
								? "This browser has no WebGPU."
								: "WebGPU could not start here."}
						</p>
						<p>
							The demo runs the real engine, which needs WebGPU. Try a recent
							Chrome, Edge or Safari.
						</p>
					</div>
				</div>
			)}
		</div>
	);
}
