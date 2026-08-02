"use client";

import { TriangleAlert, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useSnapshot } from "valtio";
import { useTranslation } from "@/locales";
import { notificationState, resolveBanner } from "@/stores/notificationStore";
import type { AppErrorCode } from "@/utils/errorReporting";
import { useEventCallback } from "@/utils/hooks";

/**
 * Renders ongoing-degradation banners (e.g. autosave failing) from
 * notificationState, fixed at top center just below the DesktopMenuBar.
 * z-40 keeps banners below the Toast viewport (z-50).
 */
export function NotificationBannerHost() {
	const { banners } = useSnapshot(notificationState);
	const t = useTranslation();

	// Single delegated handlers: the banner key travels via data attribute,
	// so per-banner inline closures are not needed.
	const handleActionClick = useEventCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			const key = event.currentTarget.dataset.bannerKey as AppErrorCode;
			notificationState.banners.find((b) => b.key === key)?.action?.onClick();
		},
	);

	const handleDismissClick = useEventCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			resolveBanner(event.currentTarget.dataset.bannerKey as AppErrorCode);
		},
	);

	if (banners.length === 0) return null;

	return (
		<div className="fixed top-[calc(2.5rem+var(--spacing-safe-top)+0.5rem)] left-1/2 z-40 flex w-[calc(100vw-2rem)] max-w-[480px] -translate-x-1/2 flex-col gap-2 pointer-events-none">
			{banners.map((banner) => (
				<div
					key={banner.key}
					role="alert"
					className="pointer-events-auto relative flex items-start gap-3 rounded-xl border border-warn bg-warn/60 px-4 py-3 pr-11 shadow-lg backdrop-liquid"
				>
					<TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
					<div className="flex flex-col">
						<div className="text-sm leading-5 font-medium text-warn-foreground">
							{t(banner.titleKey)}
						</div>
						{banner.descriptionKey && (
							<div className="text-xs leading-5 text-muted-foreground">
								{t(banner.descriptionKey)}
							</div>
						)}
						{banner.action && (
							<button
								type="button"
								data-banner-key={banner.key}
								onClick={handleActionClick}
								className="mt-1 self-start text-xs font-medium text-accent hover:underline"
							>
								{t(banner.action.labelKey)}
							</button>
						)}
					</div>
					<button
						type="button"
						aria-label="Dismiss notification"
						data-banner-key={banner.key}
						onClick={handleDismissClick}
						className="absolute top-2.5 right-2.5 flex h-6 w-6 items-center justify-center rounded-full opacity-70 transition-colors hover:bg-foreground/8 hover:opacity-100"
					>
						<X size={14} />
					</button>
				</div>
			))}
		</div>
	);
}
