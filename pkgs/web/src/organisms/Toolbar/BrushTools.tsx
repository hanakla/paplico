"use client";

import {
	ChevronDown,
	Copy,
	Download,
	ImagePlus,
	Import,
	Trash2,
	X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { DashPatternControls } from "@/components/DashPatternControls";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Select } from "@/components/Select";
import { SimpleSelect } from "@/components/SimpleSelect";
import { InfiniteSlider, Slider } from "@/components/Slider";
import { ToggleGroup } from "@/components/ToggleGroup";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico, usePaplicoMaybe } from "@/contexts/PaplicoContext";
import {
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
} from "@/core/brush/brushSource";
import { normalizeBrushSettingsV2 } from "@/core/brush/migrate";
import { normalizeBrushSettings } from "@/core/brush/normalize";
import { BUILTIN_PRESET_CATEGORY_ORDER } from "@/core/brush/presets";
import { createStrokeBrushSettings } from "@/core/document/factory";
import type {
	BrushArtSource,
	BrushColorMode,
	BrushPreset,
	BrushPresetCategory,
	BrushStroking,
	Color,
	EmbeddedFile,
	LineCap,
	LineJoin,
	PathSegment,
	PatternBrushSettings,
	ScatterBrushSettings,
	StampRotation,
} from "@/core/schema";
import {
	type BrushSettings,
	type BrushSettingsV2,
	isGeometricBrush,
} from "@/core/schema";
import { createBrushTextureFile } from "@/core/utils/embeddedFile";
import { useBrushEdits } from "@/hooks/useBrushEdits";
import { useBrushPresets } from "@/hooks/useBrushPresets";
import { FileSystem } from "@/infra/filesystem";
import { type LocalizeKeys, useTranslation } from "@/locales";
import type { BrushStrokePreviewSource } from "@/repos/brushPresets";
import {
	setBrushDesignerTargetFilterIndex,
	setSelectedBrushPresetUid,
	useUIState,
} from "@/stores/uiStore";
import { useAsyncEffect, useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { BrushMatrixSection } from "./BrushMatrixSection";

function useSyncBrushSettingsWithSelection(): void {
	const paplico = usePaplico();
	const commands = paplico.commands;
	const store = paplico.uiState;
	const docSnap = useSnapshot(store);
	const uiSnap = useUIState();
	const targetFilterIndex = uiSnap.brushDesignerTargetFilterIndex;

	const snap = useSnapshot(paplico.tools.state);
	const brushSettings = useFlatBrushView(
		snap.strokeAppearance?.paramData.params.brushSettings,
	);

	const prevSelectedIds = useRef(docSnap.selectedElementIds);

	useEffect(() => {
		const selectionChanged =
			prevSelectedIds.current !== docSnap.selectedElementIds;
		prevSelectedIds.current = docSnap.selectedElementIds;
		if (selectionChanged) {
			// An appearance target is bound to the element it was opened from.
			if (targetFilterIndex != null) setBrushDesignerTargetFilterIndex(null);
			return;
		}

		if (docSnap.selectedElementIds.length === 0) return;
		if (targetFilterIndex != null) {
			commands.updateSelectedElementStrokeBrushSettings(
				targetFilterIndex,
				brushSettings.union,
			);
		} else {
			commands.updateSelectedElementsBrushSettings(brushSettings.union);
		}
	}, [
		brushSettings.union,
		commands,
		docSnap.selectedElementIds,
		targetFilterIndex,
	]);
}

/** Canonical S-curve stroke for brush preview: one period ±10 amplitude,
 *  pressure taper in/out. Delta times are monotonic and follow a hand-drawn
 *  pace (slow ramp-in → ~1.2 px/ms cruise → slow ramp-out) so speed-driven
 *  brush dynamics show up in the preview. */
const PREVIEW_SEGMENTS: PathSegment[] = [
	{
		start: { x: -150, y: 0 },
		cp1: { x: 25, y: 4 },
		cp2: { x: -20, y: 3 },
		end: { x: -50, y: 10 },
		isMoved: true,
		startPressure: 0,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 130,
	},
	{
		cp1: { x: 18, y: -4 },
		cp2: { x: -15, y: -3 },
		end: { x: 0, y: 0 },
		isMoved: false,
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 130,
		endDeltaTime: 170,
	},
	{
		cp1: { x: 18, y: -4 },
		cp2: { x: -18, y: -3 },
		end: { x: 60, y: -10 },
		isMoved: false,
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 170,
		endDeltaTime: 220,
	},
	{
		cp1: { x: 22, y: 4 },
		cp2: { x: -20, y: 3 },
		end: { x: 150, y: 0 },
		isMoved: false,
		startPressure: 1,
		endPressure: 0,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 220,
		endDeltaTime: 380,
	},
];

const brushStrokePreviewCache = new Map<string, Promise<ImageData | null>>();

export const BrushSettingsPanel = memo(function BrushSettingsPanel({
	onOpenDesigner,
}: {
	onOpenDesigner: () => void;
}) {
	const t = useTranslation();
	const paplico = usePaplico();
	const tools = paplico.tools;
	const brushPresets = useBrushPresets();
	const brushEdits = useBrushEdits();

	const snap = useSnapshot(tools.state);
	const brushSettings = useFlatBrushView(
		snap.strokeAppearance?.paramData.params.brushSettings,
	);

	useSyncBrushSettingsWithSelection();

	const handlePresetSelect = useEventCallback(async (presetUid: string) => {
		await brushPresets.applyBrushPreset(presetUid);
	});

	const handleDuplicatePreset = useEventCallback(async (presetUid: string) => {
		await brushPresets.duplicateBrushPreset(presetUid);
	});

	const handleSizeChange = useEventCallback((size: number) => {
		brushEdits.setBrushSize(size);
	});

	const builtinPresetGroups = useMemo(
		() => groupBuiltinPresetsByCategory(brushPresets.builtinPresets),
		[brushPresets.builtinPresets],
	);

	const panelRef = useRef<HTMLDivElement>(null);
	const [previewWidth, setPreviewWidth] = useState(314);

	useEffect(() => {
		const el = panelRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry)
				setPreviewWidth(
					Math.max(100, Math.floor(entry.contentRect.width) - 12),
				);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<div ref={panelRef} className="w-82 max-w-full space-y-2">
			<div className="rounded-xl border border-border/30 bg-foreground/[0.03] p-1">
				<div className="flex items-center gap-3 px-3 py-1.5">
					<span className="shrink-0 text-xs text-muted-foreground">
						{t("toolbar.size")}
					</span>
					<InfiniteSlider
						min={0.01}
						max={Infinity}
						range={100}
						step={0.1}
						value={brushSettings.size}
						onValueChange={handleSizeChange}
					/>
					<span className="w-9 shrink-0 text-right text-xs font-mono tabular-nums text-foreground">
						{brushSettings.size.toFixed(1)}
					</span>
				</div>
			</div>

			<div className="rounded-xl border border-border/30 bg-foreground/[0.03] p-1">
				<div className="max-h-80 space-y-3 overflow-y-auto pr-1">
					<div className="space-y-2">
						{brushPresets.persistedPresets.length === 0 ? (
							<div className="rounded-lg border border-dashed border-border/30 px-3 py-4 text-center text-[11px] leading-4 text-muted-foreground">
								{t("toolbar.emptyPresetLibrary")}
							</div>
						) : (
							<div className="space-y-2">
								{brushPresets.persistedPresets.map((preset) => (
									<BrushPresetCard
										key={preset.uid}
										name={preset.name}
										preview={brushPresets.getPersistedPresetPreviewSource(
											preset.uid,
										)}
										isActive={
											brushPresets.selectedBrushPresetUid === preset.uid
										}
										onClick={() => void handlePresetSelect(preset.uid)}
										onDuplicate={() => void handleDuplicatePreset(preset.uid)}
									/>
								))}
							</div>
						)}
					</div>

					<div className="space-y-2">
						<p className="text-xs font-medium text-muted-foreground">
							{t("toolbar.factoryPresets")}
						</p>
						{builtinPresetGroups.map((group) => (
							<div key={group.category} className="space-y-2">
								<p className="text-[11px] text-muted-foreground">
									{t(BRUSH_CATEGORY_LABEL_KEYS[group.category])}
								</p>
								<div className="space-y-2">
									{group.presets.map((preset) => (
										<BrushPresetCard
											key={preset.uid}
											name={preset.name}
											preview={brushPresets.getBuiltinPresetPreviewSource(
												preset.uid,
											)}
											isActive={
												brushPresets.selectedBrushPresetUid === preset.uid
											}
											onClick={() => void handlePresetSelect(preset.uid)}
											onDuplicate={
												isGeometricBrush(preset.settings)
													? undefined
													: () => void handleDuplicatePreset(preset.uid)
											}
										/>
									))}
								</div>
							</div>
						))}
					</div>
				</div>
			</div>

			<div className="rounded-xl border border-border/30 bg-foreground/[0.03] p-1.5">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: preview double-click to open designer */}
				<div onDoubleClick={onOpenDesigner}>
					<BrushStrokePreview
						brushSettings={brushSettings.union}
						textureFile={
							brushPresets.activePresetPreviewSource?.textureFile ?? null
						}
						width={previewWidth}
						height={52}
						className="mb-1 rounded-[10px] border-border/15 bg-background/55 cursor-pointer"
					/>
				</div>

				<button
					type="button"
					className="flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04]"
					onClick={onOpenDesigner}
				>
					<div className="min-w-0">
						<p className="text-xs text-muted-foreground">
							{t("toolbar.brushDesigner")}
						</p>
					</div>
					<div className="flex items-center gap-2 text-xs font-medium text-foreground">
						<span>{t("toolbar.openBrushDesigner")}</span>
						<ChevronDown size={16} className="-rotate-90" />
					</div>
				</button>
			</div>
		</div>
	);
});

export const BrushDesignerPanel = memo(function BrushDesignerPanel({
	onClose,
	onSaved,
	initialPresetUid,
	variant = "desktop",
	side = "left",
}: {
	onClose: () => void;
	onSaved: () => void;
	initialPresetUid: string | null;
	variant?: "desktop" | "mobile";
	/** Which edge the toolbar this panel hangs off sits on. */
	side?: "left" | "right";
}) {
	const t = useTranslation();
	const paplico = usePaplico();
	const tools = paplico.tools;
	const commands = paplico.commands;
	const store = paplico.uiState;
	const brushPresets = useBrushPresets();
	const snap = useSnapshot(tools.state);
	const brushSettings = useFlatBrushView(
		snap.strokeAppearance?.paramData.params.brushSettings,
	);
	const headerRef = useRef<HTMLDivElement>(null);
	const [previewWidth, setPreviewWidth] = useState(440);
	// Name typed in this panel session. Kept even when there is no persisted
	// preset to rename yet, so saving picks it up.
	const [editingName, setEditingName] = useState<string | null>(null);

	useSyncBrushSettingsWithSelection();

	const initialPreset = useMemo(() => {
		if (!initialPresetUid) return null;

		const persisted = brushPresets.persistedPresets.find(
			(p) => p.uid === initialPresetUid,
		);
		if (persisted)
			return { uid: persisted.uid, name: persisted.name, persisted: true };

		const builtin = brushPresets.builtinPresets.find(
			(p) => p.uid === initialPresetUid,
		);
		if (builtin)
			return { uid: builtin.uid, name: builtin.name, persisted: false };

		return null;
	}, [
		initialPresetUid,
		brushPresets.persistedPresets,
		brushPresets.builtinPresets,
	]);

	const presetName =
		editingName ?? initialPreset?.name ?? t("toolbar.customMix");

	useEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setPreviewWidth(Math.floor(entry.contentRect.width));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const handleImportTexture = useEventCallback(async () => {
		await brushPresets.importCustomTexture();
	});

	const handleImportScatterTexture = useEventCallback(async () => {
		const handle = await FileSystem.openFileDialog({
			id: "brush-scatter-texture-import",
			types: [
				{
					description: "Image Files",
					accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp"] },
				},
			],
		});
		if (!handle) return;

		const embeddedFile = await createBrushTextureFile(handle.file);
		const textureFileUid = commands.addEmbeddedFile(embeddedFile);
		const current =
			tools.brushSettings.type === "scatter"
				? resolveScatterSourceUids(tools.brushSettings.scatterSources)
				: [];

		updateBrushSettings({
			scatterTextureUids: [...current, textureFileUid],
		});
	});

	const handleRemoveScatterTexture = useEventCallback((uid: string) => {
		const current =
			tools.brushSettings.type === "scatter"
				? resolveScatterSourceUids(tools.brushSettings.scatterSources)
				: [];
		updateBrushSettings({
			scatterTextureUids: current.filter((u) => u !== uid),
		});
	});

	const updateBrushSettings = useEventCallback((patch: FlatBrushPatch) => {
		setSelectedBrushPresetUid(null);
		tools.setBrushSettings(applyFlatPatch(tools.brushSettings, patch));
	});

	// The curve matrix edits the stored settings themselves: the flat view
	// above can only express what a v1 brush had, so anything it does not
	// carry would be dropped by a round trip through it.
	const matrixSettings = useMemo(
		() =>
			normalizeBrushSettingsV2(
				snap.strokeAppearance?.paramData.params.brushSettings,
			),
		[snap.strokeAppearance?.paramData.params.brushSettings],
	);

	const handleMatrixChange = useEventCallback((next: BrushSettingsV2) => {
		setSelectedBrushPresetUid(null);
		tools.setBrushSettings(next);
	});

	const handleStrokingChange = useEventCallback(
		(patch: Partial<BrushStroking>) => {
			updateBrushSettings({ stroking: patch });
		},
	);

	const currentTextureValue = useMemo(() => {
		if (brushSettings.isGeometric) return "__none__";
		const u = brushSettings.union;
		if (
			(u.type === "scatter" || u.type === "art" || u.type === "pattern") &&
			u.source?.kind === "def"
		) {
			return `def:${u.source.defId}`;
		}
		return brushSettings.textureFileUid || "__none__";
	}, [
		brushSettings.isGeometric,
		brushSettings.union,
		brushSettings.textureFileUid,
	]);

	const currentTextureFile = useMemo(() => {
		if (currentTextureValue === "__none__") return null;
		if (currentTextureValue.startsWith("def:")) return null;
		return (
			brushPresets.customTextureFiles.find(
				(f) => f.uid === currentTextureValue,
			) ??
			brushPresets.builtinFiles.find((f) => f.uid === currentTextureValue) ??
			null
		);
	}, [
		currentTextureValue,
		brushPresets.customTextureFiles,
		brushPresets.builtinFiles,
	]);

	const textureSelectItems = useMemo(() => {
		const items: Array<{ value: string; label: string }> = [
			{ value: "__none__", label: t("toolbar.noBrush") },
		];
		for (const file of brushPresets.customTextureFiles) {
			items.push({ value: file.uid, label: file.name });
		}
		for (const file of brushPresets.builtinFiles) {
			items.push({ value: file.uid, label: file.name });
		}
		if (store.document.defs) {
			for (const def of Object.values(store.document.defs)) {
				items.push({
					value: `def:${def.id}`,
					label: def.name ?? def.id,
				});
			}
		}
		return items;
	}, [
		brushPresets.customTextureFiles,
		brushPresets.builtinFiles,
		store.document.defs,
		t,
	]);

	const handleDisableBrush = useEventCallback(() => {
		setSelectedBrushPresetUid(null);
		tools.setSvgBrush();
	});

	const handleTextureChange = useEventCallback((value: string) => {
		if (value === "__none__") {
			handleDisableBrush();
		} else if (value.startsWith("def:")) {
			tools.setBrushSettings({
				type: "scatter",
				source: { kind: "def", defId: value.slice(4) },
			});
			setSelectedBrushPresetUid(null);
		} else {
			tools.setBrushSettings({
				type: "scatter",
				source: { kind: "file", fileUid: value },
			});
			setSelectedBrushPresetUid(null);
		}
	});

	const handlePresetSelect = useEventCallback(async (presetUid: string) => {
		await brushPresets.applyBrushPreset(presetUid);
	});

	const handlePresetNameChange = useEventCallback(
		async (name: string | undefined) => {
			const nextName = name?.trim();
			if (!nextName) return;

			setEditingName(nextName);
			if (!initialPreset?.persisted) return;
			await brushPresets.renameBrushPreset(initialPreset.uid, nextName);
		},
	);

	const handleDeletePreset = useEventCallback(async () => {
		if (!initialPreset?.persisted) return;
		await brushPresets.deleteBrushPreset(initialPreset.uid);
	});

	const handleExportPreset = useEventCallback(async () => {
		if (!initialPreset?.persisted) return;
		await brushPresets.exportBrushPresetAsPapb(initialPreset.uid);
	});

	const handleImportPapb = useEventCallback(async () => {
		await brushPresets.importPapbToBrushPresets();
	});

	const handleSavePreset = useEventCallback(async () => {
		if (initialPreset?.persisted) {
			await brushPresets.updateBrushPreset(initialPreset.uid);
		} else {
			await brushPresets.saveCurrentBrushPreset(presetName);
		}

		onClose();
		onSaved();
	});

	const panelSectionHeadingClassName =
		"text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80";

	return (
		<div
			className={twm(
				"flex h-full flex-col overflow-auto",
				variant === "desktop"
					? "w-full px-3 border border-border/30 bg-background/86 shadow-2xl backdrop-liquid"
					: "w-full px-3 bg-background",
				variant === "desktop" &&
					(side === "left"
						? "rounded-r-xl rounded-l-none border-l-0"
						: "rounded-l-xl rounded-r-none border-r-0"),
			)}
		>
			<div className="pb-6">
				{/* Top: Preset name, preview, and operations */}
				<div
					ref={headerRef}
					className="flex-none border-b border-border/20 px-0 pt-2 pb-2.5"
				>
					<div className="flex items-center justify-between gap-">
						<div className="min-w-0 flex-1">
							<FakeInput
								$size="sm"
								$side="start"
								value={presetName}
								onChange={handlePresetNameChange}
							/>
						</div>

						<div className="flex items-center gap-1">
							<Button $size="sm" $variant="ghost" onClick={onClose}>
								{t("toolbar.closeBrushDesigner")}
							</Button>
							<Button $size="sm" onClick={handleSavePreset}>
								{initialPreset?.persisted
									? t("toolbar.overwriteBrushDesigner")
									: t("toolbar.saveBrushDesigner")}
							</Button>
						</div>
					</div>

					<BrushStrokePreview
						brushSettings={brushSettings.union}
						textureFile={
							brushPresets.currentCustomTextureFile ??
							brushPresets.builtinFiles.find(
								(f) => f.uid === brushSettings.textureFileUid,
							) ??
							null
						}
						width={previewWidth}
						height={64}
						className="mt-1 rounded-lg border-border/15 bg-background/55"
					/>

					<div className="mt-1 -ml-1 flex items-center gap-1">
						<div className="flex gap-0.5">
							<Tooltip content={t("toolbar.importPreset")} side="top">
								<IconButton
									$size="sm"
									$variant="ghost"
									onClick={handleImportPapb}
									$clickOnPointerUpOnly
								>
									<Import size={14} />
								</IconButton>
							</Tooltip>
							<Tooltip content={t("toolbar.exportPreset")} side="top">
								<IconButton
									$size="sm"
									$variant="ghost"
									onClick={handleExportPreset}
									disabled={!initialPreset?.persisted}
									$clickOnPointerUpOnly
								>
									<Download size={14} />
								</IconButton>
							</Tooltip>

							<Tooltip content={t("toolbar.deleteBrush")} side="top">
								<IconButton
									$size="sm"
									$variant="ghost"
									onClick={handleDeletePreset}
									disabled={!initialPreset?.persisted}
									$clickOnPointerUpOnly
								>
									<Trash2 size={14} />
								</IconButton>
							</Tooltip>
						</div>
					</div>

					<PresetSelect
						persistedPresets={brushPresets.persistedPresets}
						builtinPresets={brushPresets.builtinPresets}
						selectedUid={brushPresets.selectedBrushPresetUid}
						onSelect={handlePresetSelect}
						getPersistedPreview={brushPresets.getPersistedPresetPreviewSource}
						getBuiltinPreview={brushPresets.getBuiltinPresetPreviewSource}
					/>
				</div>

				{/* Bottom: Parameters */}
				<div className="min-h-0 flex-1 py-2.5">
					<div className="flex flex-col gap-3.5">
						{/* Preset list */}
						<p className={panelSectionHeadingClassName}>
							{t("toolbar.textureSection")}
						</p>

						<div className="flex items-center gap-2">
							<Select.Root
								value={currentTextureValue}
								onValueChange={handleTextureChange}
								items={textureSelectItems}
								modal={false}
							>
								<Select.Trigger $size="sm" className="min-w-0 flex-1">
									<div className="flex min-w-0 flex-1 items-center gap-1.5">
										{currentTextureFile && (
											<BrushThumbnail
												file={currentTextureFile}
												size={16}
												className="shrink-0 rounded-sm"
											/>
										)}
										<Select.Value
											className="min-w-0 flex-1 truncate text-left"
											placeholder={t("toolbar.noBrush")}
										/>
									</div>
									<Select.Icon />
								</Select.Trigger>
								<Select.Portal>
									<Select.Positioner>
										<Select.Popup>
											<Select.Item value="__none__">
												<Select.ItemIndicator />
												<div className="col-start-2">
													<Select.ItemText>
														{t("toolbar.noBrush")}
													</Select.ItemText>
												</div>
											</Select.Item>

											{brushPresets.customTextureFiles.map((file) => (
												<Select.Item key={file.uid} value={file.uid}>
													<Select.ItemIndicator />
													<div className="col-start-2 flex items-center gap-2">
														<BrushThumbnail
															file={file}
															size={32}
															className="shrink-0 rounded-sm"
														/>
														<Select.ItemText>{file.name}</Select.ItemText>
													</div>
												</Select.Item>
											))}

											{brushPresets.builtinFiles.map((file) => (
												<Select.Item key={file.uid} value={file.uid}>
													<Select.ItemIndicator />
													<div className="col-start-2 flex items-center gap-2">
														<BrushThumbnail
															file={file}
															size={32}
															className="shrink-0 rounded-sm"
														/>
														<Select.ItemText>{file.name}</Select.ItemText>
													</div>
												</Select.Item>
											))}

											{store.document.defs &&
											Object.keys(store.document.defs).length > 0 ? (
												<>
													<div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
														{t("toolbar.defsSection")}
													</div>
													{Object.values(store.document.defs).map((def) => (
														<Select.Item key={def.id} value={`def:${def.id}`}>
															<Select.ItemIndicator />
															<Select.ItemText>
																{def.name ?? def.id}
															</Select.ItemText>
														</Select.Item>
													))}
												</>
											) : null}
										</Select.Popup>
									</Select.Positioner>
								</Select.Portal>
							</Select.Root>

							<Tooltip content={t("toolbar.importTexture")} side="top">
								<IconButton
									$size="sm"
									$variant="ghost"
									onClick={handleImportTexture}
									$clickOnPointerUpOnly
								>
									<ImagePlus size={14} />
								</IconButton>
							</Tooltip>
						</div>

						{!brushSettings.isGeometric ? (
							<>
								{/* Color mode */}
								<div className="flex flex-col gap-1.5">
									<span className="text-xs text-muted-foreground">
										{t("toolbar.colorMode")}
									</span>
									<ToggleGroup.Root
										value={[brushSettings.colorMode ?? "tinting"]}
										onValueChange={(value) => {
											const mode = value[0] as "tinting" | "color" | undefined;
											if (mode) updateBrushSettings({ colorMode: mode });
										}}
									>
										<ToggleGroup.Item
											value="tinting"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("toolbar.colorModeTinting")}
										</ToggleGroup.Item>
										<ToggleGroup.Item
											value="color"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("toolbar.colorModeColor")}
										</ToggleGroup.Item>
									</ToggleGroup.Root>
								</div>

								{/* Render mode */}
								<div className="flex flex-col gap-1.5">
									<span className="text-xs text-muted-foreground">
										{t("toolbar.renderMode")}
									</span>
									<ToggleGroup.Root
										value={[brushSettings.renderMode ?? "stamp"]}
										onValueChange={(value) => {
											const mode = value[0] as "stamp" | "ribbon" | undefined;
											if (mode) updateBrushSettings({ renderMode: mode });
										}}
									>
										<ToggleGroup.Item
											value="stamp"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("toolbar.renderModeStamp")}
										</ToggleGroup.Item>
										<ToggleGroup.Item
											value="ribbon"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("toolbar.renderModeRibbon")}
										</ToggleGroup.Item>
									</ToggleGroup.Root>
								</div>

								{/* Stamp-specific settings */}
								{(brushSettings.renderMode ?? "stamp") === "stamp" ? (
									<>
										{/* Scatter-only settings: these fields exist only on the
										    scatter union member, so the sliders would be dead
										    controls for other stamp brushes. */}
										{brushSettings.union.type === "scatter" ? (
											<>
												<div className="flex flex-col gap-1">
													<span className="text-xs text-muted-foreground">
														{t("toolbar.stampRotation")}
													</span>
													<ToggleGroup.Root
														value={[brushSettings.stampRotation]}
														onValueChange={(value) => {
															const mode = value[0] as
																| StampRotation
																| undefined;
															if (mode)
																updateBrushSettings({ stampRotation: mode });
														}}
													>
														<ToggleGroup.Item
															value="none"
															className="h-5 w-auto px-1.5 text-[10px]"
														>
															{t("toolbar.rotationNone")}
														</ToggleGroup.Item>
														<ToggleGroup.Item
															value="tangent"
															className="h-5 w-auto px-1.5 text-[10px]"
														>
															{t("toolbar.rotationTangent")}
														</ToggleGroup.Item>
														<ToggleGroup.Item
															value="random"
															className="h-5 w-auto px-1.5 text-[10px]"
														>
															{t("toolbar.rotationRandom")}
														</ToggleGroup.Item>
													</ToggleGroup.Root>
												</div>
											</>
										) : null}

										{brushSettings.union.type === "scatter" ? (
											<>
												{/* Scatter texture variants */}
												<div className="flex flex-col gap-1.5">
													<div className="flex items-center justify-between">
														<span className="text-xs text-muted-foreground">
															{t("toolbar.scatterTextures")}
														</span>
														<Tooltip
															content={t("toolbar.addScatterTexture")}
															side="top"
														>
															<IconButton
																$size="sm"
																$variant="ghost"
																onClick={handleImportScatterTexture}
																$clickOnPointerUpOnly
															>
																<ImagePlus size={12} />
															</IconButton>
														</Tooltip>
													</div>

													{(brushSettings.scatterTextureUids?.length ?? 0) >
													0 ? (
														<div className="flex flex-wrap gap-1">
															{brushSettings.scatterTextureUids!.map((uid) => {
																const file =
																	brushPresets.builtinFiles.find(
																		(f) => f.uid === uid,
																	) ??
																	store.document.files.find(
																		(f) => f.uid === uid,
																	);

																return (
																	<div key={uid} className="group relative">
																		<BrushThumbnail
																			file={file}
																			size={28}
																			className="rounded border border-border/25"
																		/>
																		<button
																			type="button"
																			className="absolute -top-1 -right-1 hidden size-3.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
																			onClick={() =>
																				handleRemoveScatterTexture(uid)
																			}
																		>
																			<X size={8} />
																		</button>
																	</div>
																);
															})}
														</div>
													) : (
														<span className="text-[10px] text-muted-foreground/60">
															{t("toolbar.scatterTexturesEmpty")}
														</span>
													)}
												</div>

												{/* Start / End textures */}
												<div className="flex gap-2">
													<SimpleSelect
														className="min-w-0 flex-1"
														$size="sm"
														label={t("toolbar.startTexture")}
														items={[
															{
																label: t("toolbar.noneTexture"),
																value: "",
															},
															...brushPresets.builtinFiles.map((f) => ({
																label: f.name,
																value: f.uid,
															})),
														]}
														value={brushSettings.startTextureUid ?? ""}
														onValueChange={(value) =>
															updateBrushSettings({
																startTextureUid: (value as string) || undefined,
															})
														}
													/>
													<SimpleSelect
														className="min-w-0 flex-1"
														$size="sm"
														label={t("toolbar.endTexture")}
														items={[
															{
																label: t("toolbar.noneTexture"),
																value: "",
															},
															...brushPresets.builtinFiles.map((f) => ({
																label: f.name,
																value: f.uid,
															})),
														]}
														value={brushSettings.endTextureUid ?? ""}
														onValueChange={(value) =>
															updateBrushSettings({
																endTextureUid: (value as string) || undefined,
															})
														}
													/>
												</div>
											</>
										) : null}
									</>
								) : null}

								{/* Ribbon-specific settings */}
								{(brushSettings.renderMode ?? "stamp") === "ribbon" ? (
									<>
										<BrushSettingSlider
											label={t("toolbar.ribbonStretch")}
											valueLabel={`${((brushSettings.ribbonStretch ?? 0) * 100).toFixed(0)}%`}
											min={-0.9}
											max={5}
											step={0.1}
											value={brushSettings.ribbonStretch ?? 0}
											onValueChange={(value) =>
												updateBrushSettings({ ribbonStretch: value })
											}
										/>
										<BrushSettingSlider
											label={t("toolbar.ribbonOffset")}
											valueLabel={`${((brushSettings.ribbonOffset ?? 0) * 100).toFixed(0)}%`}
											min={0}
											max={1}
											step={0.01}
											value={brushSettings.ribbonOffset ?? 0}
											onValueChange={(value) =>
												updateBrushSettings({ ribbonOffset: value })
											}
										/>
									</>
								) : null}
							</>
						) : (
							<>
								<div className="flex flex-col gap-1">
									<span className="text-xs text-muted-foreground">
										{t("filterPanel.lineCap")}
									</span>
									<ToggleGroup.Root
										value={[brushSettings.lineCap]}
										onValueChange={(value) => {
											const cap = value[0] as LineCap | undefined;
											if (cap) updateBrushSettings({ lineCap: cap });
										}}
									>
										<ToggleGroup.Item
											value="butt"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("filterPanel.capButt")}
										</ToggleGroup.Item>
										<ToggleGroup.Item
											value="round"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("filterPanel.capRound")}
										</ToggleGroup.Item>
										<ToggleGroup.Item
											value="square"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("filterPanel.capSquare")}
										</ToggleGroup.Item>
									</ToggleGroup.Root>
								</div>

								<div className="flex flex-col gap-1">
									<span className="text-xs text-muted-foreground">
										{t("filterPanel.joinType")}
									</span>
									<ToggleGroup.Root
										value={[brushSettings.lineJoin]}
										onValueChange={(value) => {
											const join = value[0] as LineJoin | undefined;
											if (join) updateBrushSettings({ lineJoin: join });
										}}
									>
										<ToggleGroup.Item
											value="miter"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("filterPanel.joinMiter")}
										</ToggleGroup.Item>
										<ToggleGroup.Item
											value="round"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("filterPanel.joinRound")}
										</ToggleGroup.Item>
										<ToggleGroup.Item
											value="bevel"
											className="h-5 w-auto px-1.5 text-[10px]"
										>
											{t("filterPanel.joinBevel")}
										</ToggleGroup.Item>
									</ToggleGroup.Root>
								</div>

								<DashPatternControls
									stroking={
										brushSettings.union.type === "stroke"
											? brushSettings.union.stroking
											: undefined
									}
									strokeWidth={brushSettings.size}
									onChange={handleStrokingChange}
								/>
							</>
						)}

						<p className={twm(panelSectionHeadingClassName, "pt-1")}>
							{t("toolbar.brushResponse")}
						</p>

						<BrushMatrixSection
							settings={matrixSettings}
							onChange={handleMatrixChange}
						/>
					</div>
				</div>
			</div>
		</div>
	);
});

export const BrushPresetCard = memo(function BrushPresetCard({
	name,
	preview,
	isActive,
	onClick,
	onDuplicate,
}: {
	name: string;
	preview: BrushStrokePreviewSource | null;
	isActive: boolean;
	onClick: () => void;
	onDuplicate?: () => void;
}) {
	const t = useTranslation();

	const handleClick = useEventCallback(() => {
		onClick();
	});

	const handleDuplicate = useEventCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		onDuplicate?.();
	});

	return (
		<button
			type="button"
			className={twm(
				"group flex w-full flex-col gap-1 overflow-auto rounded-lg border px-2.5 py-1.5 text-left transition-colors",
				isActive
					? "border-accent/40 bg-accent/10"
					: "border-border/20 bg-background/60 hover:bg-foreground/[0.04]",
			)}
			onClick={handleClick}
		>
			<div className="flex w-full items-center gap-1">
				<p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
					{name}
				</p>

				{onDuplicate ? (
					<Tooltip content={t("toolbar.duplicatePreset")} side="top">
						<button
							type="button"
							className="shrink-0 rounded-md p-1 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
							onClick={handleDuplicate}
						>
							<Copy size={12} />
						</button>
					</Tooltip>
				) : null}
			</div>

			{preview ? (
				<BrushStrokePreview
					brushSettings={preview.brushSettings}
					textureFile={preview.textureFile}
					width={144}
					height={28}
					className="w-full rounded border-0 bg-transparent"
				/>
			) : (
				<div className="h-7 w-full rounded bg-background/70" />
			)}
		</button>
	);
});

const PresetSelect = memo(function PresetSelect({
	persistedPresets,
	builtinPresets,
	selectedUid,
	onSelect,
	getPersistedPreview,
	getBuiltinPreview,
}: {
	persistedPresets: Array<{ uid: string; name: string }>;
	builtinPresets: Array<{ uid: string; name: string; settings: unknown }>;
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	getPersistedPreview: (uid: string) => BrushStrokePreviewSource | null;
	getBuiltinPreview: (uid: string) => BrushStrokePreviewSource | null;
}) {
	const t = useTranslation();

	const items = useMemo(
		() => [
			...persistedPresets.map((p) => ({ value: p.uid, label: p.name })),
			...builtinPresets.map((p) => ({ value: p.uid, label: p.name })),
		],
		[persistedPresets, builtinPresets],
	);

	const handleValueChange = useEventCallback((value: string) => {
		onSelect(value);
	});

	return (
		<Select.Root
			value={selectedUid ?? undefined}
			onValueChange={handleValueChange}
			items={items}
			modal={false}
		>
			<Select.Trigger $size="sm" className="mt-1.5 w-full">
				<Select.Value
					className="min-w-0 flex-1 truncate text-left"
					placeholder={t("toolbar.selectPreset")}
				/>
				<Select.Icon />
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner>
					<Select.Popup className="min-w-72">
						{persistedPresets.length > 0 ? (
							<>
								{persistedPresets.map((preset) => {
									const preview = getPersistedPreview(preset.uid);
									return (
										<Select.Item key={preset.uid} value={preset.uid}>
											<Select.ItemIndicator />
											<div className="col-start-2 flex flex-col gap-1">
												<Select.ItemText>{preset.name}</Select.ItemText>
												{preview ? (
													<BrushStrokePreview
														brushSettings={preview.brushSettings}
														textureFile={preview.textureFile}
														width={220}
														height={24}
														className="w-full rounded border-0 bg-transparent"
													/>
												) : null}
											</div>
										</Select.Item>
									);
								})}
								<div className="px-3 py-1 text-[10px] text-muted-foreground/60">
									{t("toolbar.factoryPresets")}
								</div>
							</>
						) : null}
						{builtinPresets.map((preset) => {
							const preview = getBuiltinPreview(preset.uid);
							return (
								<Select.Item key={preset.uid} value={preset.uid}>
									<Select.ItemIndicator />
									<div className="col-start-2 flex flex-col gap-1">
										<Select.ItemText>{preset.name}</Select.ItemText>
										{preview ? (
											<BrushStrokePreview
												brushSettings={preview.brushSettings}
												textureFile={preview.textureFile}
												width={220}
												height={24}
												className="w-full rounded border-0 bg-transparent"
											/>
										) : null}
									</div>
								</Select.Item>
							);
						})}
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
});

export const BrushSettingSlider = memo(function BrushSettingSlider({
	label,
	valueLabel,
	min,
	max,
	step,
	value,
	onValueChange,
}: {
	label: string;
	valueLabel: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onValueChange: (value: number) => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{label}</span>
				<span className="text-xs font-mono tabular-nums text-foreground">
					{valueLabel}
				</span>
			</div>
			<Slider
				min={min}
				max={max}
				step={step}
				value={value}
				onValueChange={onValueChange}
			/>
		</div>
	);
});

export function BrushThumbnail({
	file,
	size = 24,
	className,
}: {
	file: EmbeddedFile | undefined;
	size?: number;
	className?: string;
}) {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const prevUrlRef = useRef<string | null>(null);

	useEffect(() => {
		if (prevUrlRef.current) {
			URL.revokeObjectURL(prevUrlRef.current);
			prevUrlRef.current = null;
		}
		if (!file) {
			setBlobUrl(null);
			return;
		}
		const blob = new Blob([new Uint8Array(file.bin)], {
			type: file.type || "image/png",
		});
		const url = URL.createObjectURL(blob);
		prevUrlRef.current = url;
		setBlobUrl(url);

		return () => {
			URL.revokeObjectURL(url);
			prevUrlRef.current = null;
		};
	}, [file]);

	if (!blobUrl) {
		return (
			<div
				className={`bg-muted rounded ${className ?? ""}`}
				style={{ width: size, height: size }}
			/>
		);
	}

	return (
		// biome-ignore lint/performance/noImgElement: blob URLs cannot use Next.js Image
		<img
			src={blobUrl}
			alt=""
			width={size}
			height={size}
			className={`rounded object-cover ${className ?? ""}`}
			style={{ imageRendering: "pixelated" }}
		/>
	);
}

export function BrushStrokePreview({
	brushSettings,
	textureFile,
	width,
	height,
	className,
}: {
	brushSettings: BrushSettings | BrushSettingsV2;
	textureFile: EmbeddedFile | null;
	width: number;
	height: number;
	className?: string;
}) {
	const paplico = usePaplicoMaybe();
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [hasPreview, setHasPreview] = useState(false);
	const [themeForeground] = useState(() =>
		typeof document !== "undefined"
			? resolveCssVarColor(document.body, "--foreground")
			: "rgb(17, 24, 39)",
	);

	const cacheKey = useMemo(
		() =>
			createBrushStrokePreviewCacheKey({
				brushSettings,
				textureHash:
					textureFile?.hash ?? resolveBrushTextureUid(brushSettings) ?? "",
				width,
				height,
				themeForeground,
			}),
		[brushSettings, textureFile?.hash, width, height, themeForeground],
	);

	useAsyncEffect(
		async (signal) => {
			const canvas = canvasRef.current;
			if (!paplico || !canvas) {
				setHasPreview(false);
				return;
			}

			const context = canvas.getContext("2d");
			if (!context) {
				setHasPreview(false);
				return;
			}

			const imageData = await getOrCreateBrushStrokePreview(
				cacheKey,
				async () =>
					paplico.renderBrushStrokePreviewToImageData({
						brushSettings,
						textureFile,
						segments: PREVIEW_SEGMENTS,
						width,
						height,
						strokeColor: cssColorToColor(themeForeground),
					}),
			);
			if (signal.aborted || !canvasRef.current) return;
			if (!imageData) {
				setHasPreview(false);
				return;
			}

			context.clearRect(0, 0, width, height);
			context.putImageData(
				imageData,
				Math.round((width - imageData.width) / 2),
				Math.round((height - imageData.height) / 2),
			);
			setHasPreview(true);
		},
		[
			paplico,
			cacheKey,
			brushSettings,
			textureFile,
			width,
			height,
			themeForeground,
		],
	);

	return (
		<div
			ref={rootRef}
			className={twm(
				"relative overflow-hidden rounded-md border border-border/20 bg-background/70 text-foreground",
				className,
			)}
			style={{ width, height }}
		>
			<canvas
				ref={canvasRef}
				width={width}
				height={height}
				className={twm(
					"block h-full w-full",
					hasPreview ? "opacity-100" : "opacity-0",
				)}
			/>
			{!hasPreview && textureFile ? (
				<div className="absolute inset-0 flex items-center justify-center">
					<BrushThumbnail
						file={textureFile}
						size={Math.min(width, height) - 8}
						className="rounded-sm"
					/>
				</div>
			) : null}
		</div>
	);
}

type BrushStrokePreviewCacheKeyInput = {
	brushSettings: BrushSettings | BrushSettingsV2;
	textureHash: string;
	width: number;
	height: number;
	themeForeground: string;
};

function createBrushStrokePreviewCacheKey({
	brushSettings,
	textureHash,
	width,
	height,
	themeForeground,
}: BrushStrokePreviewCacheKeyInput): string {
	return JSON.stringify({
		brushSettings,
		textureHash,
		width,
		height,
		themeForeground,
	});
}

async function getOrCreateBrushStrokePreview(
	cacheKey: string,
	createPreview: () => Promise<ImageData | null>,
): Promise<ImageData | null> {
	let promise = brushStrokePreviewCache.get(cacheKey);
	if (!promise) {
		promise = createPreview().then((imageData) => {
			if (!imageData) {
				brushStrokePreviewCache.delete(cacheKey);
			}
			return imageData;
		});
		brushStrokePreviewCache.set(cacheKey, promise);
	}

	try {
		return await promise;
	} catch (error) {
		brushStrokePreviewCache.delete(cacheKey);
		throw error;
	}
}

function cssColorToColor(source: string): Color {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext("2d");
	if (!context) {
		return parseRgbColor(source);
	}

	context.clearRect(0, 0, 1, 1);
	context.fillStyle = source;
	context.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
	return {
		type: "rgb",
		r: r / 255,
		g: g / 255,
		b: b / 255,
		a: a / 255,
	};
}

function resolveCssVarColor(
	element: HTMLElement,
	variableName: string,
): string {
	const probe = element.ownerDocument.createElement("div");
	probe.style.color = `var(${variableName})`;
	probe.style.position = "absolute";
	probe.style.pointerEvents = "none";
	probe.style.opacity = "0";
	element.append(probe);
	const color = getComputedStyle(probe).color;
	probe.remove();
	return color || getComputedStyle(element).color || "rgb(17, 24, 39)";
}

function parseRgbColor(source: string): Color {
	const parts = source
		.replace(/^rgba?\(/, "")
		.replace(/\)$/, "")
		.trim()
		.split(/[,\s/]+/)
		.filter(Boolean)
		.map(Number);

	if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) {
		return { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
	}

	return {
		type: "rgb",
		r: parts[0] / 255,
		g: parts[1] / 255,
		b: parts[2] / 255,
		a: parts[3] ?? 1,
	};
}

// ---------------------------------------------------------------------------
// Flat brush view-model bridge (local to this panel)
//
// The brush UI is built on a single flat parameter object, while the
// persisted `BrushSettings` is a tagged union. This bridge normalizes the
// union into a flat view for reading and converts flat patches back into a
// union for writing. It is isolated to this UI component on purpose.
// ---------------------------------------------------------------------------

type FlatBrushView = {
	union: BrushSettings;
	isGeometric: boolean;
	size: number;
	colorMode: BrushColorMode | undefined;
	textureFileUid: string;
	stampRotation: StampRotation;
	scatterTextureUids: string[] | undefined;
	startTextureUid: string | undefined;
	endTextureUid: string | undefined;
	renderMode: "stamp" | "ribbon";
	ribbonStretch: number;
	ribbonOffset: number;
	lineCap: LineCap;
	lineJoin: LineJoin;
};

type FlatBrushPatch = Partial<{
	size: number;
	colorMode: BrushColorMode;
	stampRotation: StampRotation;
	scatterTextureUids: string[];
	startTextureUid: string | undefined;
	endTextureUid: string | undefined;
	renderMode: "stamp" | "ribbon";
	ribbonStretch: number;
	ribbonOffset: number;
	lineCap: LineCap;
	lineJoin: LineJoin;
	stroking: Partial<BrushStroking>;
}>;

function useFlatBrushView(raw: unknown): FlatBrushView {
	const cacheKey = JSON.stringify(raw ?? null);

	return useMemo(
		() => toFlatBrushView(cacheKey === "null" ? null : JSON.parse(cacheKey)),
		[cacheKey],
	);
}

function toFlatBrushView(raw: unknown): FlatBrushView {
	const u =
		raw != null ? normalizeBrushSettings(raw) : createStrokeBrushSettings(2);

	return {
		union: u,
		isGeometric: isGeometricBrush(u),
		size: u.size,
		colorMode: u.colorMode,
		textureFileUid: resolveBrushTextureUid(u) ?? "",
		stampRotation: u.type === "scatter" ? u.stampRotation : "none",
		scatterTextureUids:
			u.type === "scatter"
				? resolveScatterSourceUids(u.scatterSources)
				: undefined,
		startTextureUid:
			u.type === "scatter"
				? resolveOptionalSourceUid(u.startSource)
				: undefined,
		endTextureUid:
			u.type === "scatter" ? resolveOptionalSourceUid(u.endSource) : undefined,
		renderMode: u.type === "pattern" ? "ribbon" : "stamp",
		ribbonStretch: u.type === "pattern" ? u.tileScale - 1 : 0,
		ribbonOffset: u.type === "pattern" ? (u.uvOffset ?? 0) : 0,
		lineCap: u.type === "stroke" ? (u.stroking?.lineCap ?? "round") : "round",
		lineJoin: u.type === "stroke" ? (u.stroking?.lineJoin ?? "round") : "round",
	};
}

function applyFlatPatch(
	current: BrushSettings,
	patch: FlatBrushPatch,
): BrushSettings {
	// renderMode switches the brush kind; resolve it first so subsequent
	// flat fields apply onto the correct union member.
	let next: BrushSettings = current;
	if (patch.renderMode === "ribbon") {
		next = toPattern(current);
	} else if (patch.renderMode === "stamp") {
		next = toScatter(current);
	}

	// Base fields exist on every union member.
	if (patch.size !== undefined) next.size = patch.size;
	if (patch.colorMode !== undefined) next.colorMode = patch.colorMode;

	if (next.type === "pattern") {
		if (patch.ribbonStretch !== undefined)
			next.tileScale = 1 + patch.ribbonStretch;
		if (patch.ribbonOffset !== undefined) next.uvOffset = patch.ribbonOffset;
	}

	if (next.type === "scatter") {
		if (patch.stampRotation !== undefined)
			next.stampRotation = patch.stampRotation;
		if (patch.scatterTextureUids !== undefined) {
			next.scatterSources =
				patch.scatterTextureUids.length > 0
					? patch.scatterTextureUids.map(toFileSource)
					: undefined;
		}
		if (patch.startTextureUid !== undefined) {
			next.startSource = patch.startTextureUid
				? toFileSource(patch.startTextureUid)
				: undefined;
		}
		if (patch.endTextureUid !== undefined) {
			next.endSource = patch.endTextureUid
				? toFileSource(patch.endTextureUid)
				: undefined;
		}
	}

	if (next.type === "stroke") {
		if (
			patch.lineCap !== undefined ||
			patch.lineJoin !== undefined ||
			patch.stroking !== undefined
		) {
			const prev = next.stroking;
			next.stroking = {
				lineCap: patch.lineCap ?? prev?.lineCap ?? "round",
				lineJoin: patch.lineJoin ?? prev?.lineJoin ?? "round",
				miterLimit: prev?.miterLimit ?? 4,
				dashArray: prev?.dashArray,
				dashOffset: prev?.dashOffset,
				...patch.stroking,
			};
		}
	}

	return next;
}

function toPattern(current: BrushSettings): PatternBrushSettings {
	if (current.type === "pattern") return { ...current };
	return {
		size: current.size,
		sizeByPressure: current.sizeByPressure,
		opacity: current.opacity,
		opacityByPressure: current.opacityByPressure,
		randomSeed: current.randomSeed,
		colorMode: current.colorMode,
		type: "pattern",
		source: resolveSource(current),
		flow: "flow" in current ? current.flow : 1,
		tileScale: 1,
		tileSpacing: 0,
		uvOffset: undefined,
		fitMode: "none",
	};
}

function toScatter(current: BrushSettings): ScatterBrushSettings {
	if (current.type === "scatter") return { ...current };
	return {
		size: current.size,
		sizeByPressure: current.sizeByPressure,
		opacity: current.opacity,
		opacityByPressure: current.opacityByPressure,
		randomSeed: current.randomSeed,
		colorMode: current.colorMode,
		type: "scatter",
		source: resolveSource(current),
		spacing: 0.1,
		flow: "flow" in current ? current.flow : 1,
		stampRotation: "none",
		rotationByTilt: 0,
		aspectRatioByTilt: 0,
		sizeBySpeed: 0,
		pooling: 0,
		poolingSizeRatio: 0.5,
	};
}

function resolveSource(settings: BrushSettings): BrushArtSource {
	if (
		settings.type === "scatter" ||
		settings.type === "art" ||
		settings.type === "pattern"
	) {
		return settings.source;
	}
	const fileUid = resolveBrushTextureUid(settings);
	return { kind: "file", fileUid: fileUid ?? "" };
}

function toFileSource(fileUid: string): BrushArtSource {
	return { kind: "file", fileUid };
}

const BRUSH_CATEGORY_LABEL_KEYS: Record<
	BrushPresetCategory | "other",
	LocalizeKeys
> = {
	pen: "toolbar.brushCategoryPen",
	airbrush: "toolbar.brushCategoryAirbrush",
	watercolor: "toolbar.brushCategoryWatercolor",
	calligraphy: "toolbar.brushCategoryCalligraphy",
	effect: "toolbar.brushCategoryEffect",
	other: "toolbar.brushCategoryOther",
};

/** Group builtin presets into categorized shelves, keeping a stable order. */
function groupBuiltinPresetsByCategory(
	presets: BrushPreset[],
): Array<{ category: BrushPresetCategory | "other"; presets: BrushPreset[] }> {
	const grouped = Object.groupBy(
		presets,
		(preset) => preset.category ?? "other",
	);
	return BUILTIN_PRESET_CATEGORY_ORDER.flatMap((category) => {
		const group = grouped[category];
		return group?.length ? [{ category, presets: group }] : [];
	});
}
