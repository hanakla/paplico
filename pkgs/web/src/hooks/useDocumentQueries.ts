import { useLiveQuery } from "dexie-react-hooks";
import { type DocumentMeta, db } from "@/infra/documentDB";

/** All data needed for the document list dialog. */
export function useDocumentListData(): {
	documents: DocumentMeta[] | undefined;
	revisionCounts: Record<string, number> | undefined;
} {
	const documents = useLiveQuery(
		() => db.documentMeta.orderBy("updatedAt").reverse().toArray(),
		[],
	);

	const revisionCounts = useLiveQuery(async () => {
		const counts: Record<string, number> = {};
		await db.documentRevisions.each((rev) => {
			counts[rev.documentId] = (counts[rev.documentId] ?? 0) + 1;
		});
		return counts;
	}, []);

	return { documents, revisionCounts };
}
