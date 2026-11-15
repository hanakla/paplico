import { Menu as BUIMenu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import { findUnusedFileUids } from "@paplico/core/io";
import {
	type Artboard,
	type BoundingBox,
	type Document,
	getArtboardBounds,
} from "@paplico/core/schema";
import {
	Ellipsis,
	Link2,
	Package,
	Replace,
	SquareDashedMousePointer,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import { toastManager } from "@/components/Toast";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useCurrentCanvasTargetResolver } from "@/hooks/useCurrentCanvasTarget";
import { confirmDialog } from "@/infra/confirmDialog";
import { useTranslation } from "@/locales";
import { ArtboardList } from "@/organisms/ArtboardList";
import {
	collectAssetElementIds,
	collectAssetFileUids,
	linkedFilesState,
	replaceAssetFile,
} from "@/stores/linkedFilesStore";
import { useEventCallback } from "@/utils/hooks";

/** How long the document has to stay unchanged before it is searched for
 *  unused files. */
const UNUSED_FILES_CHECK_DELAY_MS = 300;

/**
 * Tabs for the files the elements of the document show, embedded or linked to
 * their source, and for the artboards.
 */
export function AssetPanel() {
	const t = useTranslation();
	const paplico = usePaplico();
	const doc = useSnapshot(paplico.uiState).document;
	const { objects, references3d, files } = doc;
	const { status } = useSnapshot(linkedFilesState);
	const rootRef = useRef<HTMLDivElement>(null);
	const [tab, setTab] = useState("assets");

	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();

	const fitViewportToBounds = useEventCallback((bounds: BoundingBox) => {
		const target = getCurrentCanvasTarget(paplico);
		if (!target || !rootRef.current) return;

		paplico.fitViewportToBounds(target.id, bounds, {
			insets: coveredInsets(
				rootRef.current.getBoundingClientRect(),
				target.canvas.getBoundingClientRect(),
			),
		});
	});

	const handleSelectElements = useEventCallback((uid: string) => {
		const elementIds = collectAssetElementIds({ objects, references3d }, uid);
		// Selecting nothing leaves the former selection in place, and the view
		// would move to it
		if (elementIds.length === 0) return;

		paplico.selection.selectMultiple(elementIds);

		const bounds = paplico.uiState.selectionBounds;
		if (bounds) fitViewportToBounds(bounds);
	});

	const handleFitArtboard = useEventCallback((artboard: Artboard) => {
		fitViewportToBounds(getArtboardBounds(artboard));
	});

	const handleRemoveUnusedFiles = useEventCallback(async () => {
		if (!(await confirmDialog(t("assetPanel.removeUnusedConfirm")))) return;
		const count = paplico.commands.removeUnusedFiles();
		toastManager.add({
			title: t("assetPanel.unusedRemoved", { count }),
			type: "success",
		});
	});

	// The search walks the whole document, and a drag changes the document on
	// every pointer move, so it waits until the changes stop.
	const [hasUnusedFiles, setHasUnusedFiles] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => {
			setHasUnusedFiles(findUnusedFileUids(doc as Document).length > 0);
		}, UNUSED_FILES_CHECK_DELAY_MS);
		return () => clearTimeout(timer);
	}, [doc]);

	const assetFiles = useMemo(() => {
		const assetUids = collectAssetFileUids({ objects, references3d });
		return files.filter((file) => assetUids.has(file.uid));
	}, [objects, references3d, files]);

	return (
		<Tabs.Root
			ref={rootRef}
			value={tab}
			onValueChange={setTab}
			className="w-52 bg-background/80 backdrop-liquid rounded-lg shadow-lg flex flex-col overflow-hidden"
		>
			<div className="pl-3 pr-1 py-1 border-b border-border flex items-center shrink-0">
				<span className="flex-1 type-panel-title leading-5 text-muted-foreground">
					{t("assetPanel.assets")}
				</span>
				{tab === "assets" && (
					<Menu.Root>
						<BUIMenu.Trigger
							render={
								<IconButton
									$size="xs"
									$variant="ghost"
									aria-label={t("assetPanel.moreActions")}
								>
									<Ellipsis size={14} />
								</IconButton>
							}
						/>
						<Menu.Portal>
							<Menu.Positioner side="bottom" align="end" sideOffset={4}>
								<Menu.Popup>
									<Menu.Item
										disabled={!hasUnusedFiles}
										onClick={() => void handleRemoveUnusedFiles()}
									>
										<Trash2 size={14} />
										{t("assetPanel.removeUnused")}
									</Menu.Item>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				)}
			</div>
			<Tabs.List className="px-2 py-1 border-b border-border flex gap-1 shrink-0">
				<Tabs.Tab
					value="assets"
					className="type-label rounded px-2 py-0.5 text-muted-foreground hover:text-foreground data-active:bg-foreground/10 data-active:text-foreground"
				>
					{t("assetPanel.assets")}
				</Tabs.Tab>
				<Tabs.Tab
					value="artboards"
					className="type-label rounded px-2 py-0.5 text-muted-foreground hover:text-foreground data-active:bg-foreground/10 data-active:text-foreground"
				>
					{t("assetPanel.artboards")}
				</Tabs.Tab>
			</Tabs.List>

			<Tabs.Panel value="assets" className="min-h-0 flex-1 flex flex-col">
				{assetFiles.length === 0 ? (
					<p className="px-3 py-2 text-xs text-muted-foreground">
						{t("assetPanel.noAssets")}
					</p>
				) : (
					<ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
						{assetFiles.map((file) => (
							<li
								key={file.uid}
								className="flex items-center gap-1.5 py-0.5 pl-3 pr-1"
							>
								{file.sourcePath ? (
									<Link2
										className="shrink-0 text-muted-foreground"
										size={14}
										aria-label={t("assetPanel.linked")}
									>
										<title>{file.sourcePath}</title>
									</Link2>
								) : (
									<Package
										className="shrink-0 text-muted-foreground"
										size={14}
										aria-label={t("assetPanel.embedded")}
									>
										<title>{t("assetPanel.embedded")}</title>
									</Package>
								)}
								<span className="min-w-0 flex-1 truncate text-xs">
									{file.name}
								</span>
								{status[file.uid] === "missing" && (
									<TriangleAlert
										className="shrink-0 text-yellow-500"
										size={14}
										aria-label={t("assetPanel.sourceMissing")}
									>
										<title>{t("assetPanel.sourceMissing")}</title>
									</TriangleAlert>
								)}
								<Menu.Root>
									<BUIMenu.Trigger
										render={
											<IconButton
												$size="xs"
												$variant="ghost"
												aria-label={t("assetPanel.moreActions")}
											>
												<Ellipsis size={14} />
											</IconButton>
										}
									/>
									<Menu.Portal>
										<Menu.Positioner side="bottom" align="end" sideOffset={4}>
											<Menu.Popup>
												<Menu.Item
													onClick={() => handleSelectElements(file.uid)}
												>
													<SquareDashedMousePointer size={14} />
													{t("assetPanel.selectElements")}
												</Menu.Item>
												<Menu.Item
													disabled={!file.type.startsWith("image/")}
													onClick={() => void replaceAssetFile(paplico, file)}
												>
													<Replace size={14} />
													{t("assetPanel.replace")}
												</Menu.Item>
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.Root>
							</li>
						))}
					</ul>
				)}
			</Tabs.Panel>

			<Tabs.Panel value="artboards" className="min-h-0 flex-1 flex flex-col">
				<ArtboardList onFit={handleFitArtboard} />
			</Tabs.Panel>
		</Tabs.Root>
	);
}

/**
 * The part of the canvas the panel's surface covers, as insets along the
 * canvas edges. A panel as wide as half the canvas or more is a sheet rising
 * from the bottom; a narrower one stands in a column on the side it is nearer.
 */
function coveredInsets(
	panel: DOMRect,
	canvas: DOMRect,
): Partial<Record<"right" | "bottom" | "left", number>> {
	if (panel.width >= canvas.width / 2) {
		return { bottom: canvas.bottom - panel.top };
	}

	return panel.left + panel.width / 2 < canvas.left + canvas.width / 2
		? { left: panel.right - canvas.left }
		: { right: canvas.right - panel.left };
}
