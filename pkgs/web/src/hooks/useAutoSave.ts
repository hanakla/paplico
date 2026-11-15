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

/**
 * Saves the current document and a revision of it on a timer, when it was
 * edited since the last save.
 * Takes `paplico` as an argument because the page that calls it renders
 * PaplicoProvider itself, so the context is not available there.
 */
export function useAutoSave(paplico: Paplico | null): { save: () => void } {
	const { currentDocumentId } = useSnapshot(documentManagerState);
	const { source } = useSnapshot(documentSessionState);
	// A room's document is not the one the current id names, so it has no
	// record to be saved under.
	const documentId = source.kind === "room" ? null : currentDocumentId;

	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// A ref so edits survive the timer effect restarting on interval changes
	const hasUnsavedRevisionRef = useRef(false);

	const { intervalMs } = useSnapshot(autoSaveState);

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
			// The record a reload opens is written first, so a failed revision
			// still leaves the latest content in it.
			try {
				await saveDocument(documentId, doc);
				resolveBanner("AUTOSAVE_FAILED");
			} catch (cause) {
				hasUnsavedRevisionRef.current = true;
				reportError({ code: "AUTOSAVE_FAILED", channel: "banner", cause });
			}
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
