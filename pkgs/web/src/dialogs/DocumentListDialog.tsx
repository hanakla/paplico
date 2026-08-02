import { useLiveQuery } from "dexie-react-hooks";
import {
	ChevronRight,
	Copy,
	File,
	MoreHorizontal,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useSnapshot } from "valtio";
import { Accordion } from "@/components/Accordion";
import { ConfirmDialog } from "@/components/AlertDialog";
import { Dialog } from "@/components/Dialog";
import { FakeInput } from "@/components/FakeInput";
import { Menu } from "@/components/Menu";
import { Spinner } from "@/components/Spinner";
import { SwipeAction } from "@/components/SwipeAction";
import type { Paplico } from "@/core/Paplico";
import { setLastDocumentId } from "@/hooks/useAppConfig";
import { useDocumentListData } from "@/hooks/useDocumentQueries";
import {
	type DocumentData,
	type DocumentMeta,
	type DocumentRevision,
	type DocumentSnapshot,
	db,
} from "@/infra/documentDB";
import { useTranslation } from "@/locales";
import {
	setInternalDocumentSession,
	setSnapshotDocumentSession,
} from "@/stores/documentSessionStore";
import {
	createDocument,
	deleteDocument,
	documentManagerState,
	duplicateDocument,
	listDocumentMetas,
	loadDocumentData,
	renameDocument,
	saveDocument,
} from "@/stores/documentStore";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

export const DocumentListDialog = memo(function DocumentListDialog({
	open,
	onOpenChange,
	paplico,
	onRequestNewDocument,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	paplico: Paplico | null;
	onRequestNewDocument?: () => void;
}) {
	const t = useTranslation();
	const docManagerSnap = useSnapshot(documentManagerState);

	const { documents, revisionCounts } = useDocumentListData();

	const [expandedDocId, setExpandedDocId] = useState<string[]>([]);

	const expandedRevisions = useLiveQuery(async () => {
		if (expandedDocId.length === 0) return {};
		const result: Record<string, DocumentRevision[]> = {};
		for (const docId of expandedDocId) {
			result[docId] = (
				await db.documentRevisions
					.where("documentId")
					.equals(docId)
					.sortBy("createdAt")
			).reverse();
		}
		return result;
	}, [expandedDocId]);

	const expandedDocData = useLiveQuery(async () => {
		if (expandedDocId.length === 0) return {};
		const result: Record<string, DocumentData> = {};
		for (const docId of expandedDocId) {
			const data = await db.documentData.get(docId);
			if (data) result[docId] = data;
		}
		return result;
	}, [expandedDocId]);

	const handleOpenDocument = useEventCallback(async (id: string) => {
		if (!paplico) return;

		// Load and switch
		const data = await loadDocumentData(id);
		if (!data) return;
		await paplico.importDocument(data.document);
		documentManagerState.currentDocumentId = id;
		setInternalDocumentSession(id);
		setLastDocumentId(id);
		onOpenChange(false);
	});

	const handleOpenRevision = useEventCallback(
		async (snapshot: DocumentSnapshot) => {
			if (!paplico) return;
			await paplico.importDocument(snapshot.document);
			setSnapshotDocumentSession();
			onOpenChange(false);
		},
	);

	const handleCreateDocument = useEventCallback(async () => {
		if (!paplico) return;

		// Save current document
		const currentId = documentManagerState.currentDocumentId;
		if (currentId) {
			await saveDocument(currentId, await paplico.exportDocument());
		}

		const newId = await createDocument(t("documentList.untitled"));

		// Load the new empty document
		const data = await loadDocumentData(newId);
		if (!data) return;

		await paplico.importDocument(data.document);
		documentManagerState.currentDocumentId = newId;
		setLastDocumentId(newId);
		onOpenChange(false);
	});

	const handleDelete = useEventCallback(async (doc: DocumentMeta) => {
		const confirmed = await ConfirmDialog.call({
			description: t("documentList.deleteConfirm", { name: doc.name } as any),
			confirmLabel: t("documentList.delete"),
			destructive: true,
		});
		if (!confirmed) return;

		await deleteDocument(doc.id);

		// If the deleted document was the current one, switch to another
		if (doc.id === documentManagerState.currentDocumentId && paplico) {
			const remaining = await listDocumentMetas();
			if (remaining.length > 0) {
				const data = await loadDocumentData(remaining[0].id);
				if (data) {
					await paplico.importDocument(data.document);
					documentManagerState.currentDocumentId = remaining[0].id;
					setLastDocumentId(remaining[0].id);
				}
			} else {
				// No documents left — create a new one
				const newId = await createDocument(t("documentList.untitled"));
				const data = await loadDocumentData(newId);
				if (data) {
					await paplico.importDocument(data.document);
					documentManagerState.currentDocumentId = newId;
					setLastDocumentId(newId);
				}
			}
		}
	});

	const handleDuplicate = useEventCallback(async (doc: DocumentMeta) => {
		await duplicateDocument(doc.id, `${doc.name} (copy)`);
	});

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[520px] max-h-[70vh] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("documentList.title")}
					</Dialog.Title>
					<Dialog.Close>
						<button
							type="button"
							className={twm(
								"p-1 rounded hover:bg-foreground/10 transition-colors",
								"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
							)}
						>
							<X size={16} />
						</button>
					</Dialog.Close>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto p-4">
					{/* New Document Button */}
					<button
						type="button"
						onClick={onRequestNewDocument ?? handleCreateDocument}
						className={twm(
							"w-full flex items-center gap-3 px-3 py-2.5 rounded-lg",
							"border border-dashed border-border/50",
							"hover:bg-muted/50 transition-colors",
							"text-sm text-muted-foreground hover:text-foreground",
						)}
					>
						<Plus size={16} />
						{t("documentList.newDocument")}
					</button>

					{/* Document List */}
					{documents && documents.length > 0 ? (
						<Accordion.Root
							multiple
							value={expandedDocId}
							onValueChange={setExpandedDocId}
						>
							<div className="mt-3 space-y-1">
								{documents.map((doc) => (
									<DocumentRow
										key={doc.id}
										doc={doc}
										revisionCount={revisionCounts?.[doc.id] ?? 0}
										revisions={expandedRevisions?.[doc.id]}
										currentData={expandedDocData?.[doc.id]}
										isCurrent={doc.id === docManagerSnap.currentDocumentId}
										onOpen={() => handleOpenDocument(doc.id)}
										onOpenSnapshot={handleOpenRevision}
										onRename={(name) => renameDocument(doc.id, name)}
										onDelete={() => handleDelete(doc)}
										onDuplicate={() => handleDuplicate(doc)}
									/>
								))}
							</div>
						</Accordion.Root>
					) : documents !== undefined ? (
						<div className="mt-8 text-center text-sm text-muted-foreground">
							<p>{t("documentList.noDocuments")}</p>
						</div>
					) : null}
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});

// --- Document Row ---

const DocumentRow = memo(function DocumentRow({
	doc,
	revisionCount,
	revisions,
	currentData,
	isCurrent,
	onOpen,
	onOpenSnapshot,
	onRename,
	onDelete,
	onDuplicate,
}: {
	doc: DocumentMeta;
	revisionCount: number;
	revisions?: DocumentRevision[];
	currentData?: DocumentData;
	isCurrent: boolean;
	onOpen: () => void;
	onOpenSnapshot: (snapshot: DocumentSnapshot) => void;
	onRename: (name: string) => void;
	onDelete: () => void;
	onDuplicate: () => void;
}) {
	const t = useTranslation();
	const timeAgo = formatRelativeTime(doc.updatedAt);

	const handleRename = useEventCallback((value: string | undefined) => {
		if (value) onRename(value);
	});

	const handleContextMenuClick = useEventCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			e.stopPropagation();
		},
	);

	return (
		<Accordion.Item
			value={doc.id}
			className={twm(
				"rounded-lg",
				isCurrent && "bg-accent/10 ring-1 ring-accent/30",
			)}
		>
			<Accordion.Header className="m-0">
				<SwipeAction.Root className="rounded-lg">
					<SwipeAction.Content>
						<Accordion.Trigger
							className={twm(
								"flex items-center gap-3 px-3 py-2 rounded-lg group",
								"hover:bg-muted/50 transition-colors",
							)}
						>
							{/* Chevron indicator */}
							<ChevronRight
								size={14}
								className="shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
							/>

							{/* Thumbnail */}
							<div className="shrink-0 w-10 h-10 rounded bg-white flex items-center justify-center overflow-hidden">
								{doc.thumbnail ? (
									<ThumbnailImage thumbnail={doc.thumbnail} />
								) : (
									<File size={14} className="text-muted-foreground" />
								)}
							</div>

							{/* Name */}
							<div className="flex-1 min-w-0">
								<FakeInput
									value={doc.name}
									onChange={handleRename}
									$behaviour="click"
									$size="sm"
									$side="start"
									className="font-medium"
								/>
								<div className="text-xs text-muted-foreground text-left">
									{t("documentList.lastEdited", { time: timeAgo } as any)}
									{revisionCount > 0 &&
										` · ${t("documentList.revisionCount", { count: revisionCount } as any)}`}
								</div>
							</div>

							{/* Context menu */}
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper */}
							{/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper */}
							<div className="shrink-0" onClick={handleContextMenuClick}>
								<Menu.Root>
									<Menu.Trigger className="p-1 rounded transition-opacity hover:bg-foreground/10 text-foreground">
										<MoreHorizontal size={14} />
									</Menu.Trigger>
									<Menu.Portal>
										<Menu.Positioner side="bottom" align="end" sideOffset={4}>
											<Menu.Popup>
												<Menu.Item onClick={onDuplicate}>
													<Copy size={12} />
													{t("documentList.duplicate")}
												</Menu.Item>
												<Menu.Separator />
												<Menu.Item
													onClick={onDelete}
													className="text-danger data-highlighted:bg-danger/10"
												>
													<Trash2 size={12} />
													{t("documentList.delete")}
												</Menu.Item>
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.Root>
							</div>
						</Accordion.Trigger>
					</SwipeAction.Content>

					<SwipeAction.Actions>
						<SwipeAction.Action
							onClick={onDuplicate}
							className="bg-accent text-accent-foreground"
						>
							<Copy size={14} />
						</SwipeAction.Action>
						<SwipeAction.Action
							onClick={onDelete}
							className="bg-danger text-danger-foreground"
						>
							<Trash2 size={14} />
						</SwipeAction.Action>
					</SwipeAction.Actions>
				</SwipeAction.Root>
			</Accordion.Header>

			<Accordion.Panel className="overflow-hidden">
				<div className="pl-8 pr-3 pb-2 space-y-0.5">
					{/* Current snapshot */}
					{currentData && (
						<SnapshotRow
							label={t("documentList.currentSnapshot")}
							snapshot={currentData}
							onOpen={onOpen}
						/>
					)}
					{/* Revisions (newest first - already sorted) */}
					{revisions?.map((rev, i) => (
						<SnapshotRow
							key={rev.id}
							label={t("documentList.revisionLabel", {
								number: revisions.length - i,
							} as any)}
							snapshot={rev}
							onOpen={() => onOpenSnapshot(rev)}
						/>
					))}
					{!currentData && !revisions?.length && (
						<div className="text-xs text-muted-foreground py-1">
							{t("documentList.noSnapshots")}
						</div>
					)}
				</div>
			</Accordion.Panel>
		</Accordion.Item>
	);
});

// --- Snapshot Row ---

const SnapshotRow = memo(function SnapshotRow({
	label,
	snapshot,
	onOpen,
}: {
	label: string;
	snapshot: DocumentSnapshot;
	onOpen: () => void;
}) {
	const timeAgo = formatRelativeTime(snapshot.createdAt);

	return (
		<button
			type="button"
			onClick={onOpen}
			className={twm(
				"flex items-center gap-2 px-2 py-1.5 rounded w-full text-left",
				"hover:bg-muted/50 transition-colors text-xs",
			)}
		>
			<div className="shrink-0 w-6 h-6 rounded bg-white flex items-center justify-center overflow-hidden">
				{snapshot.thumbnail ? (
					<ThumbnailImage thumbnail={snapshot.thumbnail} />
				) : (
					<File size={10} className="text-muted-foreground" />
				)}
			</div>
			<span className="text-muted-foreground">{label}</span>
			<span className="text-muted-foreground ml-auto">{timeAgo}</span>
		</button>
	);
});

// --- Thumbnail Image ---

const ThumbnailImage = memo(function ThumbnailImage({
	thumbnail,
}: {
	thumbnail: Blob;
}) {
	const [url, setUrl] = useState<string | null>(null);

	useEffect(() => {
		const blobUrl = URL.createObjectURL(thumbnail);
		setUrl(blobUrl);

		return () => URL.revokeObjectURL(blobUrl);
	}, [thumbnail]);

	return url ? (
		<img src={url} alt="" className="w-full h-full object-cover" />
	) : (
		<Spinner $size="sm" />
	);
});

// --- Helpers ---

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1_000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 30) return `${days}d ago`;
	return new Date(timestamp).toLocaleDateString();
}
