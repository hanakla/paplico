import { useState } from "react";
import { useSnapshot } from "valtio";
import type {
	DocumentData,
	DocumentMeta,
	DocumentRevision,
} from "@/infra/documentDB.types";
import { useTranslation } from "@/locales";
import {
	documentNameFromFile,
	documentSessionState,
} from "@/stores/documentSessionStore";
import {
	countDocumentRevisions,
	documentManagerState,
	documentStorageState,
	listDocumentMetas,
	listDocumentRevisions,
	loadDocumentData,
	loadDocumentMeta,
} from "@/stores/documentStore";
import { useAsyncEffect } from "@/utils/hooks";

/** All data needed for the document list dialog. */
export function useDocumentListData(): {
	documents: DocumentMeta[] | undefined;
	revisionCounts: Record<string, number> | undefined;
} {
	const { changeCount } = useSnapshot(documentStorageState);
	const [data, setData] = useState<{
		documents: DocumentMeta[];
		revisionCounts: Record<string, number>;
	}>();

	useAsyncEffect(
		async (signal) => {
			const [documents, revisionCounts] = await Promise.all([
				listDocumentMetas(),
				countDocumentRevisions(),
			]);
			if (signal.aborted) return;
			setData({ documents, revisionCounts });
		},
		[changeCount],
	);

	return {
		documents: data?.documents,
		revisionCounts: data?.revisionCounts,
	};
}

/** Revisions and current content of each document whose history is open. */
export function useDocumentHistories(docIds: string[]): {
	revisions: Record<string, DocumentRevision[]> | undefined;
	data: Record<string, DocumentData> | undefined;
} {
	const { changeCount } = useSnapshot(documentStorageState);
	const [histories, setHistories] = useState<{
		revisions: Record<string, DocumentRevision[]>;
		data: Record<string, DocumentData>;
	}>();

	useAsyncEffect(
		async (signal) => {
			const revisions: Record<string, DocumentRevision[]> = {};
			const data: Record<string, DocumentData> = {};
			for (const docId of docIds) {
				revisions[docId] = await listDocumentRevisions(docId);
				const docData = await loadDocumentData(docId);
				if (docData) data[docId] = docData;
			}
			if (signal.aborted) return;
			setHistories({ revisions, data });
		},
		[docIds, changeCount],
	);

	return {
		revisions: histories?.revisions,
		data: histories?.data,
	};
}

/**
 * Name the open document goes by: the file manual saves write to, then the
 * stored document's name, then a placeholder.
 */
export function useCurrentDocumentName(): string {
	const t = useTranslation();
	const { fileHandle } = useSnapshot(documentSessionState);
	const { currentDocumentId } = useSnapshot(documentManagerState);
	const { changeCount } = useSnapshot(documentStorageState);
	const [storedName, setStoredName] = useState<string>();

	useAsyncEffect(
		async (signal) => {
			const meta = currentDocumentId
				? await loadDocumentMeta(currentDocumentId)
				: null;
			if (signal.aborted) return;
			setStoredName(meta?.name);
		},
		[currentDocumentId, changeCount],
	);

	if (fileHandle) return documentNameFromFile(fileHandle.file);
	return storedName ?? t("menubar.untitledDocument");
}
