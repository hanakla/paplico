import { proxy } from "valtio";
import {
	AUTO_SAVE_INTERVAL_MS,
	AUTO_SAVE_MAX_REVISIONS,
	AUTO_SAVE_SLOW_THRESHOLD_MS,
} from "@/configs";

// --- State ---

export const autoSaveState = proxy({
	intervalMs: AUTO_SAVE_INTERVAL_MS,
	isSlowDocument: false,
	lastSaveTimestamp: 0,
	isSaving: false,
	nextSaveAt: 0,
	saveCount: 0,
});

// --- Pure functions ---

/**
 * Return IDs of revisions that should be deleted to maintain the cap.
 * Input must be sorted by createdAt ascending.
 */
export function getRevisionIdsToPrune(
	revisions: { id: string; createdAt: number }[],
	maxCount: number = AUTO_SAVE_MAX_REVISIONS,
): string[] {
	if (revisions.length <= maxCount) return [];
	return revisions.slice(0, revisions.length - maxCount).map((r) => r.id);
}

/**
 * Determine if the save interval should be extended to the slow document interval.
 */
export function shouldExtendInterval(
	elapsedMs: number,
	thresholdMs: number = AUTO_SAVE_SLOW_THRESHOLD_MS,
): boolean {
	return elapsedMs > thresholdMs;
}

/**
 * Compute ring progress (0 to 1) based on time elapsed since last save.
 */
export function computeRingProgress(
	lastSaveTimestamp: number,
	intervalMs: number,
	now: number,
): number {
	if (intervalMs <= 0) return 1;
	const elapsed = now - lastSaveTimestamp;
	return Math.min(Math.max(elapsed / intervalMs, 0), 1);
}

/**
 * Format remaining milliseconds as "M:SS" for tooltip display.
 */
export function formatAutoSaveCountdown(remainingMs: number): string {
	if (remainingMs <= 0) return "0:00";
	const totalSeconds = Math.ceil(remainingMs / 1_000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
