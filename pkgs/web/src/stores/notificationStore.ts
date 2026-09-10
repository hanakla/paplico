import { proxy } from "valtio";
import type { LocalizeKeys } from "@/locales";
import type { AppErrorCode } from "@/utils/errorReporting";

export interface NotificationAction {
	labelKey: LocalizeKeys;
	onClick: () => void;
}

export interface BannerEntry {
	/** Stable identity used for upsert / resolve (the reported error code) */
	key: AppErrorCode;
	titleKey: LocalizeKeys;
	descriptionKey?: LocalizeKeys;
	action?: NotificationAction;
}

export interface FatalErrorState {
	code: AppErrorCode;
	titleKey: LocalizeKeys;
	descriptionKey?: LocalizeKeys;
}

interface NotificationState {
	banners: BannerEntry[];
	fatal: FatalErrorState | null;
}

export const notificationState = proxy<NotificationState>({
	banners: [],
	fatal: null,
});

/** Insert or replace the banner identified by `entry.key` (idempotent upsert). */
export function showBanner(entry: BannerEntry): void {
	const index = notificationState.banners.findIndex((b) => b.key === entry.key);
	notificationState.banners =
		index === -1
			? [...notificationState.banners, entry]
			: notificationState.banners.with(index, entry);
}

/** Remove the banner with the given key. No-op when absent. */
export function resolveBanner(key: AppErrorCode): void {
	if (!notificationState.banners.some((b) => b.key === key)) return;
	notificationState.banners = notificationState.banners.filter(
		(b) => b.key !== key,
	);
}

/** Show a fatal error. First-wins: subsequent calls are ignored. */
export function showFatal(state: FatalErrorState): void {
	if (notificationState.fatal) return;
	notificationState.fatal = state;
}
