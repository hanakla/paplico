"use client";

import { TriangleAlert } from "lucide-react";
import { useSnapshot } from "valtio";
import { useTranslation } from "@/locales";
import { notificationState } from "@/stores/notificationStore";
import { useEventCallback } from "@/utils/hooks";

/**
 * Full-screen overlay for unrecoverable errors (WebGPU unsupported / init
 * failed / device lost). z-[10000] paints above dialogs (z-auto portals)
 * and Select popups (z-[9999]). Reload is the only way out, except for
 * WEBGPU_UNSUPPORTED where reloading cannot help and only the supported
 * browser guidance (descriptionKey) is shown.
 */
export function FatalErrorOverlay() {
	const { fatal } = useSnapshot(notificationState);
	const t = useTranslation();

	const handleReload = useEventCallback(() => {
		window.location.reload();
	});

	if (!fatal) return null;

	return (
		<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
			<div
				role="alertdialog"
				className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border/50 bg-background/90 px-8 py-6 text-center shadow-lg backdrop-blur-xl"
			>
				<TriangleAlert className="size-8 text-danger" />
				<div className="text-sm font-medium text-foreground">
					{t(fatal.titleKey)}
				</div>
				{fatal.descriptionKey && (
					<div className="text-xs leading-5 text-muted-foreground">
						{t(fatal.descriptionKey)}
					</div>
				)}
				{fatal.code !== "WEBGPU_UNSUPPORTED" && (
					<button
						type="button"
						onClick={handleReload}
						className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/80 transition-colors"
					>
						{t("errors.reload")}
					</button>
				)}
			</div>
		</div>
	);
}
