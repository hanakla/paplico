import { Menu as BUIMenu } from "@base-ui/react/menu";
import {
	Ellipsis,
	Link2,
	Package,
	Replace,
	SquareDashedMousePointer,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useRef } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useCurrentCanvasTargetResolver } from "@/hooks/useCurrentCanvasTarget";
import { useTranslation } from "@/locales";
import {
	collectAssetElementIds,
	collectAssetFileUids,
	linkedFilesState,
	replaceAssetFile,
} from "@/stores/linkedFilesStore";
import { useEventCallback } from "@/utils/hooks";

/**
 * Lists the files the elements of the document show, embedded or linked to
 * their source.
 */
export function AssetPanel() {
	const t = useTranslation();
	const paplico = usePaplico();
	const { objects, references3d, files } = useSnapshot(
		paplico.uiState,
	).document;
	const { status } = useSnapshot(linkedFilesState);
	const rootRef = useRef<HTMLDivElement>(null);

	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();

	const handleSelectElements = useEventCallback((uid: string) => {
		const elementIds = collectAssetElementIds({ objects, references3d }, uid);
		// Selecting nothing leaves the former selection in place, and the view
		// would move to it
		if (elementIds.length === 0) return;

		paplico.selection.selectMultiple(elementIds);

		const bounds = paplico.uiState.selectionBounds;
		const target = getCurrentCanvasTarget(paplico);
		if (!bounds || !target || !rootRef.current) return;

		paplico.fitViewportToBounds(target.id, bounds, {
			insets: coveredInsets(
				rootRef.current.getBoundingClientRect(),
				target.canvas.getBoundingClientRect(),
			),
		});
	});

	const assetFiles = useMemo(() => {
		const assetUids = collectAssetFileUids({ objects, references3d });
		return files.filter((file) => assetUids.has(file.uid));
	}, [objects, references3d, files]);

	return (
		<div
			ref={rootRef}
			className="w-52 bg-background/80 backdrop-liquid rounded-lg shadow-lg flex flex-col overflow-hidden"
		>
			<div className="px-3 py-1 border-b border-border flex items-center shrink-0">
				<span className="type-panel-title leading-5 text-muted-foreground">
					{t("assetPanel.assets")}
				</span>
			</div>

			{assetFiles.length === 0 ? (
				<p className="px-3 py-2 text-xs text-muted-foreground">
					{t("assetPanel.noAssets")}
				</p>
			) : (
				<ul className="min-h-0 flex-1 overflow-y-auto py-1">
					{assetFiles.map((file) => (
						<li key={file.uid} className="flex items-center gap-1.5 pl-3 pr-1">
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
											<Menu.Item onClick={() => handleSelectElements(file.uid)}>
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
		</div>
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
