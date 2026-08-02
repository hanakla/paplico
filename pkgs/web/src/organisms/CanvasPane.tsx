"use client";

import { useEffect, useRef, useState } from "react";
import { ViewIdProvider } from "@/contexts/ViewIdContext";
import type { Paplico } from "@/core/Paplico";
import { clearCurrentTargetId, setCurrentTargetId } from "@/stores/uiStore";
import { reportError } from "@/utils/errorReporting";
import { useEventCallback } from "@/utils/hooks";
import { CanvasZoomToast } from "./CanvasZoomToast";
import { ContextActionsOverlay } from "./ContextAction";
import { DeviceRecoveryOverlay } from "./DeviceRecoveryOverlay";
import { MaskEditBar } from "./MaskEditBar";
import { MeshDeformHintOverlay } from "./MeshDeformHintOverlay";
import { PatternEditBar } from "./PatternEditBar";
import { RemoteCursors } from "./RemoteCursors";
import { TextEditOverlay } from "./TextEditOverlay";

interface CanvasPaneProps {
	paplico: Paplico | null;
	targetId?: string;
	isPrimary?: boolean;
	showShiftButton?: boolean;
	onCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

export function CanvasPane({
	paplico,
	targetId,
	isPrimary = false,
	onCanvasReady,
}: CanvasPaneProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const firedCanvasReadyRef = useRef(false);
	const attachedRef = useRef(false);
	const [activeTargetId, setActiveTargetId] = useState<string | null>(
		targetId ?? null,
	);
	const activeTargetIdRef = useRef<string | null>(targetId ?? null);
	const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
	const [isDeviceRecovering, setIsDeviceRecovering] = useState(false);

	useEffect(() => {
		activeTargetIdRef.current = activeTargetId;
	}, [activeTargetId]);

	const activateCurrentTarget = useEventCallback(() => {
		const targetId = activeTargetIdRef.current;
		if (!targetId) return;
		setCurrentTargetId(targetId);
	});

	// Fire onCanvasReady once on mount (before paplico is ready)
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || firedCanvasReadyRef.current) return;
		firedCanvasReadyRef.current = true;
		onCanvasReady?.(canvas);
	}, [onCanvasReady]);

	// Attach to paplico once ready
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !paplico || attachedRef.current) return;
		attachedRef.current = true;

		// Always create a new canvas target for this DOM element.
		// When targetId is provided (e.g. primary in split view), the old
		// target's viewport is migrated and the old target is removed so that
		// the new canvas DOM element receives WebGPU rendering.
		if (targetId) {
			const oldTarget = paplico.getCanvasTarget(targetId);
			const oldViewport = oldTarget?.getViewport();
			paplico.removeCanvasTarget(targetId);
			paplico
				.addCanvasTarget(canvas, {
					id: targetId,
					viewport: oldViewport,
				})
				.then((target) => {
					setActiveTargetId(target.id);
					if (isPrimary) {
						setCurrentTargetId(target.id);
					}
				});
		} else {
			paplico.addCanvasTarget(canvas).then((target) => {
				setActiveTargetId(target.id);
				if (isPrimary) {
					setCurrentTargetId(target.id);
				}
			});
		}

		const rect = canvas.getBoundingClientRect();
		setCanvasSize({ width: rect.width, height: rect.height });

		const resizeObserver = new ResizeObserver((entries) => {
			const cr = entries[0]?.contentRect;
			if (cr) setCanvasSize({ width: cr.width, height: cr.height });
		});
		resizeObserver.observe(canvas);

		const handleDeviceLost = () => setIsDeviceRecovering(true);
		const handleDeviceRestored = () => setIsDeviceRecovering(false);
		const handleDeviceRecoveryFailed = () => {
			// Hand over to the fatal overlay and unmount DeviceRecoveryOverlay.
			reportError({ code: "WEBGPU_DEVICE_LOST", channel: "fatal" });
			setIsDeviceRecovering(false);
		};

		paplico.on("deviceLost", handleDeviceLost);
		paplico.on("deviceRestored", handleDeviceRestored);
		paplico.on("deviceRecoveryFailed", handleDeviceRecoveryFailed);

		return () => {
			resizeObserver.disconnect();
			const targetId = activeTargetIdRef.current;
			if (targetId) {
				clearCurrentTargetId(targetId);
			}
			if (!isPrimary && targetId) {
				paplico.removeCanvasTarget(targetId);
			}
			paplico.off("deviceLost", handleDeviceLost);
			paplico.off("deviceRestored", handleDeviceRestored);
			paplico.off("deviceRecoveryFailed", handleDeviceRecoveryFailed);
		};
	}, [paplico, targetId, isPrimary]);

	return (
		<ViewIdProvider viewId={activeTargetId}>
			<div className="relative w-full h-full overflow-hidden">
				<canvas
					ref={canvasRef}
					className="w-full h-full block"
					style={{ touchAction: "none", overscrollBehavior: "none" }}
					onPointerDown={activateCurrentTarget}
					onPointerEnter={activateCurrentTarget}
				/>
				{activeTargetId && (
					<>
						<TextEditOverlay
							canvasWidth={canvasSize.width}
							canvasHeight={canvasSize.height}
						/>
						<ContextActionsOverlay
							canvasWidth={canvasSize.width}
							canvasHeight={canvasSize.height}
						/>
						<MeshDeformHintOverlay
							canvasWidth={canvasSize.width}
							canvasHeight={canvasSize.height}
						/>
						{/* Belongs beside the canvas, not over the window: screen
						    positions are measured from the canvas, and in split view
						    each pane answers for its own viewport. */}
						<RemoteCursors />
						<PatternEditBar />
						<MaskEditBar />
						<CanvasZoomToast />
						{isDeviceRecovering && <DeviceRecoveryOverlay />}
					</>
				)}
			</div>
		</ViewIdProvider>
	);
}
