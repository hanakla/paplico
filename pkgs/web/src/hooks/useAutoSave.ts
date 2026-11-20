import type { Paplico } from "@paplico/core";
import { useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { AUTO_SAVE_SLOW_INTERVAL_MS } from "@/configs";
import { autoSaveState, shouldExtendInterval } from "@/stores/autoSave";
import {
	documentSessionState,
	overwriteDocumentFile,
} from "@/stores/documentSessionStore";
import {
	documentManagerState,
	saveDocument,
	saveRevision,
} from "@/stores/documentStore";
import { resolveBanner } from "@/stores/notificationStore";
import { reportError } from "@/utils/errorReporting";
import { generateDocumentThumbnail } from "@/utils/generateDocumentThumbnail";
import { useEventCallback } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";

/**
 * Saves the current document and a revision of it on a timer, when it was
 * edited since the last save.
 * Takes `paplico` as an argument because the page that calls it renders
 * PaplicoProvider itself, so the context is not available there.
 */
export type UseAutoSaveOptions = {
	onSaveEnd?: () => void;
	onSaveStart?: () => void;
};

export function useAutoSave(
	paplico: Paplico | null,
	{ onSaveEnd, onSaveStart }: UseAutoSaveOptions = {},
): { save: () => void } {
	const { currentDocumentId } = useSnapshot(documentManagerState);
	const { source } = useSnapshot(documentSessionState);
	// A room's document is not the one the current id names, so it has no
	// record to be saved under.
	const documentId = source.kind === "room" ? null : currentDocumentId;

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
		onSaveStart?.();
		const start = performance.now();

		try {
			if (IS_TAURI_ENV) await saveToFile(paplico);

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
			onSaveEnd?.();
		}
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: saveRevisionNow is stable (useEventCallback)
	useEffect(() => {
		if (!paplico || !documentId) return;

		const now = Date.now();
		autoSaveState.lastSaveTimestamp = now;
		autoSaveState.nextSaveAt = now + intervalMs;

		let intervalTimer: ReturnType<typeof setTimeout> | null = null;

		const unsubscribe = paplico.getYjsProvider().on("update", () => {
			hasUnsavedRevisionRef.current = true;
		});

		const scheduleNext = () => {
			intervalTimer = setTimeout(async () => {
				await saveRevisionNow();
				scheduleNext();
			}, intervalMs);
		};

		scheduleNext();

		return () => {
			unsubscribe();

			if (intervalTimer != null) {
				clearTimeout(intervalTimer);
				intervalTimer = null;
			}
		};
	}, [paplico, documentId, intervalMs]);

	return { save: saveRevisionNow };
}

/** Writes the file manual saves target, if the document has one. */
async function saveToFile(paplico: Paplico): Promise<void> {
	const { fileHandle } = documentSessionState;
	if (!fileHandle) return;

	await overwriteDocumentFile(paplico, fileHandle);
	autoSaveState.saveCount++;
}

/** Reschedule the next auto-save; runs after every attempt, success or failure. */
function markSaveAttempted(): void {
	const now = Date.now();
	autoSaveState.lastSaveTimestamp = now;
	autoSaveState.nextSaveAt = now + autoSaveState.intervalMs;
}
