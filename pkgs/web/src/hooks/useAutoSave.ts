import type { Paplico } from "@paplico/core";
import { useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { AUTO_SAVE_SLOW_INTERVAL_MS } from "@/configs";
import { autoSaveState, shouldExtendInterval } from "@/stores/autoSave";
import { documentSessionState } from "@/stores/documentSessionStore";
import {
	documentManagerState,
	saveDocument,
	saveRevision,
} from "@/stores/documentStore";
import { resolveBanner } from "@/stores/notificationStore";
import { reportError } from "@/utils/errorReporting";
import { generateDocumentThumbnail } from "@/utils/generateDocumentThumbnail";
import { useEventCallback } from "@/utils/hooks";

const DEBOUNCE_MS = 2_000;

/**
 * Saves the current document after edits and stores revisions on a timer.
 * Takes `paplico` as an argument because the page that calls it renders
 * PaplicoProvider itself, so the context is not available there.
 */
export function useAutoSave(paplico: Paplico | null): { save: () => void } {
	const { currentDocumentId } = useSnapshot(documentManagerState);
	const { source } = useSnapshot(documentSessionState);
	// A room's document is not the one the current id names, so it has no
	// record to be saved under.
	const documentId = source.kind === "room" ? null : currentDocumentId;

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingRef = useRef(false);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// A ref so edits survive the timer effect restarting on interval changes
	const hasUnsavedRevisionRef = useRef(false);

	const { intervalMs } = useSnapshot(autoSaveState);

	// --- Debounce save (crash recovery) ---
	useEffect(() => {
		if (!paplico || !documentId) return;

		const handler = () => {
			pendingRef.current = true;

			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(async () => {
				if (!pendingRef.current || !paplico || !documentId) return;
				pendingRef.current = false;

				try {
					await saveDocument(documentId, await paplico.exportDocument());
					resolveBanner("AUTOSAVE_FAILED");
				} catch (cause) {
					reportError({ code: "AUTOSAVE_FAILED", channel: "banner", cause });
				}
			}, DEBOUNCE_MS);
		};

		const unsubscribe = paplico.getYjsProvider().on("update", handler);

		return () => {
			unsubscribe();

			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			// No save here: by the time the document id changes, the engine
			// already holds the next document, so an export would write that
			// document under this id. Whoever switches documents saves first.
		};
	}, [paplico, documentId]);

	// --- Revision save, on the timer and on demand ---
	const saveRevisionNow = useEventCallback(async () => {
		if (!paplico || !documentId || autoSaveState.isSaving) return;
		if (!hasUnsavedRevisionRef.current) {
			markSaveAttempted();
			return;
		}

		// Cleared before exporting so edits made during the save mark the next one
		hasUnsavedRevisionRef.current = false;
		autoSaveState.isSaving = true;
		const start = performance.now();

		try {
			const [doc, thumbnail] = await Promise.all([
				paplico.exportDocument(),
				generateDocumentThumbnail(paplico),
			]);
			await saveRevision(documentId, doc, thumbnail);

			const elapsed = performance.now() - start;
			if (shouldExtendInterval(elapsed) && !autoSaveState.isSlowDocument) {
				autoSaveState.isSlowDocument = true;
				autoSaveState.intervalMs = AUTO_SAVE_SLOW_INTERVAL_MS;
			}

			autoSaveState.saveCount++;
			resolveBanner("REVISION_SAVE_FAILED");
		} catch (cause) {
			hasUnsavedRevisionRef.current = true;
			reportError({ code: "REVISION_SAVE_FAILED", channel: "banner", cause });
		} finally {
			autoSaveState.isSaving = false;
			markSaveAttempted();
		}
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: saveRevisionNow is stable (useEventCallback)
	useEffect(() => {
		if (!paplico || !documentId) return;

		const now = Date.now();
		autoSaveState.lastSaveTimestamp = now;
		autoSaveState.nextSaveAt = now + intervalMs;

		const unsubscribe = paplico.getYjsProvider().on("update", () => {
			hasUnsavedRevisionRef.current = true;
		});

		const scheduleNext = () => {
			intervalRef.current = setTimeout(async () => {
				await saveRevisionNow();
				scheduleNext();
			}, intervalMs);
		};
		scheduleNext();

		return () => {
			unsubscribe();

			if (intervalRef.current) {
				clearTimeout(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [paplico, documentId, intervalMs]);

	return { save: saveRevisionNow };
}

/** Reschedule the next auto-save; runs after every attempt, success or failure. */
function markSaveAttempted(): void {
	const now = Date.now();
	autoSaveState.lastSaveTimestamp = now;
	autoSaveState.nextSaveAt = now + autoSaveState.intervalMs;
}
