import type { Paplico } from "@paplico/core";
import { useEffect } from "react";
import { useSnapshot } from "valtio";
import { toastManager } from "@/components/Toast";
import { useTranslation } from "@/locales";
import { documentSessionState } from "@/stores/documentSessionStore";
import { checkLinkedFiles, updateLinkedFile } from "@/stores/linkedFilesStore";
import { useEventCallback } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";

/** Longest file name a toast shows before it cuts out the middle. */
const MAX_FILE_NAME_LENGTH = 32;

/**
 * Compares the linked files of the open document with their sources when the
 * document changes and whenever the window regains focus, and offers to
 * update each file whose source was edited.
 */
export function useLinkedFileWatcher(paplico: Paplico | null): void {
	const t = useTranslation();
	const { identity, fileHandle } = useSnapshot(documentSessionState);

	/** `offered` holds the open offers of the document: toast ids by file uid and source hash. */
	const offerUpdates = useEventCallback(
		(
			p: Paplico,
			changed: Awaited<ReturnType<typeof checkLinkedFiles>>,
			offered: Map<string, string>,
		) => {
			for (const { file, sourceHash } of changed) {
				// One offer per edit: declining it must not bring it back on
				// the next focus
				const offer = `${file.uid}:${sourceHash}`;
				if (offered.has(offer)) continue;

				const toastId = toastManager.add({
					title: t("linkedFiles.changed"),
					description: shortenFileName(file.name),
					timeout: 0,
					actionProps: {
						autoFocus: true,
						children: t("linkedFiles.update"),
						onClick: () => {
							toastManager.close(toastId);
							void updateLinkedFile(p, file);
						},
					},
				});
				offered.set(offer, toastId);
			}
		},
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new document or document file changes which sources the paths point at
	useEffect(() => {
		if (!IS_TAURI_ENV || !paplico) return;

		const offered = new Map<string, string>();
		let active = true;
		const check = async () => {
			const changed = await checkLinkedFiles(paplico);
			// The document was replaced while the sources were being read
			if (active) offerUpdates(paplico, changed, offered);
		};

		void check();
		window.addEventListener("focus", check);
		return () => {
			active = false;
			window.removeEventListener("focus", check);
			// An offer left open would update a file of the document it was
			// made for inside the next one
			for (const toastId of offered.values()) toastManager.close(toastId);
		};
	}, [paplico, identity, fileHandle]);
}

/** Cuts out the middle of a long file name, so its start and extension stay readable. */
function shortenFileName(name: string): string {
	if (name.length <= MAX_FILE_NAME_LENGTH) return name;

	const half = (MAX_FILE_NAME_LENGTH - 1) / 2;
	return `${name.slice(0, Math.ceil(half))}…${name.slice(-Math.floor(half))}`;
}
