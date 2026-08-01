"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "@/locales";
import { reportError } from "@/utils/errorReporting";

export function DeviceRecoveryOverlay() {
	const t = useTranslation();
	const [escalatedToFatal, setEscalatedToFatal] = useState(false);

	// Fallback: if the deviceRecoveryFailed event never arrives, escalate to
	// the fatal overlay after 5s. The timer is disposed on unmount, so when
	// CanvasPane unmounts this overlay (recovery succeeded or fatal already
	// reported), no duplicate report is fired.
	useEffect(() => {
		const timer = setTimeout(() => {
			reportError({ code: "WEBGPU_DEVICE_LOST", channel: "fatal" });
			setEscalatedToFatal(true);
		}, 5_000);
		return () => clearTimeout(timer);
	}, []);

	// The fatal overlay takes over rendering; avoid double display.
	if (escalatedToFatal) return null;

	return (
		<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
			<div className="flex flex-col items-center gap-3 rounded-lg bg-background/90 backdrop-blur-xl px-8 py-6 shadow-lg border border-border/50">
				<LoaderCircle className="size-6 animate-spin text-muted-foreground" />
				<div className="text-sm font-medium text-foreground">
					{t("errors.deviceLost")}
				</div>
				<div className="text-xs text-muted-foreground">
					{t("errors.deviceRecovering")}
				</div>
			</div>
		</div>
	);
}
