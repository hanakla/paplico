import { useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { AUTO_SAVE_SLOW_INTERVAL_MS } from "@/configs";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { autoSaveState, shouldExtendInterval } from "@/stores/autoSave";
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

let initialized = false;

export function useAutoSave(): { save: () => void } {
	const paplico = usePaplicoMaybe();
	const { currentDocumentId: documentId } = useSnapshot(documentManagerState);

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingRef = useRef(false);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const { intervalMs } = useSnapshot(autoSaveState);

	// --- Debounce save (crash recovery) ---
	useEffect(() => {
		if (initialized || !paplico || !documentId) return;
		initialized = true;

		const ydoc = paplico.getYjsDoc();

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

		ydoc.on("update", handler);

		return () => {
			initialized = false;
			ydoc.off("update", handler);

			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}

			if (paplico && documentId) {
				paplico
					.exportDocument()
					.then((doc) => saveDocument(documentId, doc))
					.then(() => resolveBanner("AUTOSAVE_FAILED"))
					.catch((cause) => {
						reportError({ code: "AUTOSAVE_FAILED", channel: "banner", cause });
					});
			}
		};
	}, [paplico, documentId]);

	// --- Timer-based revision save ---
	useEffect(() => {
		if (!paplico || !documentId) return;

		const now = Date.now();
		autoSaveState.lastSaveTimestamp = now;
		autoSaveState.nextSaveAt = now + intervalMs;

		const runRevisionSave = async () => {
			if (!paplico || !documentId || autoSaveState.isSaving) return;

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
				resolveBanner("AUTOSAVE_FAILED");
			} catch (cause) {
				reportError({ code: "AUTOSAVE_FAILED", channel: "banner", cause });
			} finally {
				autoSaveState.isSaving = false;
				markSaveAttempted();
			}
		};

		const scheduleNext = () => {
			intervalRef.current = setTimeout(async () => {
				await runRevisionSave();
				scheduleNext();
			}, intervalMs);
		};
		scheduleNext();

		return () => {
			if (intervalRef.current) {
				clearTimeout(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [paplico, documentId, intervalMs]);

	// --- Manual save ---
	const save = useEventCallback(async () => {
		if (!paplico || !documentId || autoSaveState.isSaving) return;

		try {
			await saveDocument(documentId, await paplico.exportDocument());
			autoSaveState.saveCount++;
			resolveBanner("AUTOSAVE_FAILED");
		} catch (cause) {
			reportError({ code: "AUTOSAVE_FAILED", channel: "banner", cause });
		} finally {
			markSaveAttempted();
		}
	});

	return { save };
}

/** Reschedule the next auto-save; runs after every attempt, success or failure. */
function markSaveAttempted(): void {
	const now = Date.now();
	autoSaveState.lastSaveTimestamp = now;
	autoSaveState.nextSaveAt = now + autoSaveState.intervalMs;
}
