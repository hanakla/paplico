"use client";

import { Download, ImageIcon, Upload, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Dialog } from "@/components/Dialog";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { SimpleCombobox } from "@/components/SimpleCombobox";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { toastManager } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";
import { BASE_DPI, RASTERIZATION_DPI_PRESETS } from "@/configs";
import { inspectIccProfile } from "@/core/color/IccProfileRegistry";
import type { BuiltinIccProfileId } from "@/core/color/types";
import { createEmbeddedFileFromBytes } from "@/core/document/factory";
import { DEFAULT_LENGTH_UNIT, formatLength } from "@/core/document/units";
import type { Paplico } from "@/core/Paplico";
import type { Artboard, EmbeddedFile } from "@/core/schema";
import { useSystemIccProfiles } from "@/hooks/useSystemIccProfiles";
import { BUILTIN_ICC_PROFILES } from "@/infra/builtinIccProfiles";
import { FileSystem } from "@/infra/filesystem";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";
import { twm } from "@/utils/tailwind";

const THUMBNAIL_MAX_SIZE = 80;
const DEFAULT_JPEG_QUALITY = 0.92;

type ExportFormat = "png" | "jpeg" | "psd" | "avif-hdr" | "tiff" | "svg";

/** Resolved RGB ICC profile choice for PNG / JPEG export. */
export type IccExportChoice =
	| { kind: "none" }
	| { kind: "builtin"; id: BuiltinIccProfileId }
	| { kind: "embedded"; uid: string };

const ICC_FILE_PICKER_TYPES: FilePickerAcceptType[] = [
	{
		description: "ICC Profile",
		accept: { "application/vnd.iccprofile": [".icc", ".icm"] },
	},
];

interface ExportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	artboards: readonly Artboard[];
	paplico: Paplico | null;
	onExportPNG: (
		artboardIds: string[],
		scale: number,
		icc: IccExportChoice,
	) => void;
	onExportJPEG: (
		artboardIds: string[],
		scale: number,
		quality: number,
		icc: IccExportChoice,
	) => void;
	onExportPSD: (artboardIds: string[], embedIcc: boolean) => void;
	isHdrEnabled: boolean;
	onExportAvifHdr: (artboardIds: string[], scale: number) => void;
	onExportTiff: (
		artboardIds: string[],
		scale: number,
		profileValue: string,
	) => void;
	onExportSVG: (artboardIds: string[]) => void;
}

export const ExportDialog = memo(function ExportDialog({
	open,
	onOpenChange,
	artboards,
	paplico,
	onExportPNG,
	onExportJPEG,
	onExportPSD,
	isHdrEnabled,
	onExportAvifHdr,
	onExportTiff,
	onExportSVG,
}: ExportDialogProps) {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(
		() => new Set(artboards.map((a) => a.id)),
	);
	const [format, setFormat] = useState<ExportFormat>("png");
	const [dpi, setDpi] = useState(BASE_DPI);
	const [isCustomDpi, setIsCustomDpi] = useState(false);
	const [customDpiText, setCustomDpiText] = useState(String(BASE_DPI));
	const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
	const thumbnailUrlsRef = useRef<string[]>([]);
	const t = useTranslation();

	const exporter = paplico?.exporter ?? null;
	const document = paplico?.uiState.document;
	const workingSpace = document?.colorProfile?.workingSpace ?? "display-p3";
	const embeddedFiles = (document?.files ?? []) as readonly EmbeddedFile[];
	const rgbEmbeddedProfiles = embeddedFiles.filter(
		(f) => inspectIccProfile(f.bin)?.colorSpace === "rgb",
	);
	// TIFF accepts any RGB or CMYK profile (gray / Lab / XYZ are unconvertible).
	const tiffEmbeddedProfiles = embeddedFiles.filter((f) => {
		const cs = inspectIccProfile(f.bin)?.colorSpace;
		return cs === "rgb" || cs === "cmyk";
	});
	// The document's print-color-preview (proof) profile becomes the default TIFF
	// profile when it is selectable; otherwise none ("").
	const proofProfile = document?.colorProfile?.proofProfile;
	const defaultProfileValue =
		proofProfile?.kind === "builtin"
			? proofProfile.id
			: proofProfile?.kind === "embedded" &&
					tiffEmbeddedProfiles.some((p) => p.uid === proofProfile.fileUid)
				? proofProfile.fileUid
				: "";

	// RGB profile selection for PNG / JPEG. "" = no embedded profile.
	const [rgbProfileValue, setRgbProfileValue] = useState<string>(workingSpace);
	const [jpegQuality, setJpegQuality] = useState(DEFAULT_JPEG_QUALITY);
	const [embedPsdIcc, setEmbedPsdIcc] = useState(true);
	const [profileValue, setProfileValue] = useState<string>("");
	const { profiles: systemProfiles, loading: systemProfilesLoading } =
		useSystemIccProfiles();

	// Generate thumbnails when dialog opens
	useEffect(() => {
		if (!open || !exporter) return;

		let cancelled = false;
		const urls: string[] = [];

		(async () => {
			const results: Record<string, string> = {};

			for (const artboard of artboards) {
				if (cancelled) break;

				const thumbnailScale =
					THUMBNAIL_MAX_SIZE / Math.max(artboard.width, artboard.height);

				const result = await exporter.renderArtboardToPNG(artboard.id, {
					scale: Math.min(thumbnailScale, 1),
					backgroundColor: { r: 0.95, g: 0.95, b: 0.95, a: 1 },
				});

				if (cancelled || !result) continue;

				const url = URL.createObjectURL(result.blob);
				urls.push(url);
				results[artboard.id] = url;

				if (!cancelled) {
					setThumbnails((prev) => ({ ...prev, [artboard.id]: url }));
				}
			}
		})();

		thumbnailUrlsRef.current = urls;

		return () => {
			cancelled = true;
			for (const url of thumbnailUrlsRef.current) {
				URL.revokeObjectURL(url);
			}
			thumbnailUrlsRef.current = [];
			setThumbnails({});
		};
	}, [open, exporter, artboards]);

	useEffect(() => {
		if (!isHdrEnabled) {
			setFormat((prev) => (prev === "avif-hdr" ? "png" : prev));
		}
	}, [isHdrEnabled]);

	// Default the RGB profile select to the document working space when opened.
	useEffect(() => {
		if (open) setRgbProfileValue(workingSpace);
	}, [open, workingSpace]);

	// On open, default the TIFF profile to the print-color-preview profile.
	useEffect(() => {
		if (open) setProfileValue(defaultProfileValue);
	}, [open, defaultProfileValue]);

	// Reset if the chosen embedded profile is gone (builtin ids stay valid).
	useEffect(() => {
		setProfileValue((prev) =>
			prev === "" ||
			BUILTIN_ICC_PROFILES.some((p) => p.id === prev) ||
			tiffEmbeddedProfiles.some((p) => p.uid === prev)
				? prev
				: "",
		);
	}, [tiffEmbeddedProfiles]);

	const handleToggle = useEventCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	});

	const handleSelectAll = useEventCallback(() => {
		setSelectedIds(new Set(artboards.map((a) => a.id)));
	});

	const handleDeselectAll = useEventCallback(() => {
		setSelectedIds(new Set());
	});

	const parsedCustomDpi = Number(customDpiText);
	const customDpiValid =
		Number.isFinite(parsedCustomDpi) && parsedCustomDpi > 0;
	const effectiveDpi = isCustomDpi ? parsedCustomDpi : dpi;
	const scale = effectiveDpi / BASE_DPI;

	const handleExport = useEventCallback(() => {
		if (isCustomDpi && !customDpiValid) return;

		const ids = Array.from(selectedIds);
		const icc = resolveRgbIccChoice(rgbProfileValue);

		if (format === "png") {
			onExportPNG(ids, scale, icc);
		} else if (format === "jpeg") {
			onExportJPEG(ids, scale, jpegQuality, icc);
		} else if (format === "psd") {
			onExportPSD(ids, embedPsdIcc);
		} else if (format === "avif-hdr") {
			if (!isHdrEnabled) return;
			onExportAvifHdr(ids, scale);
		} else if (format === "tiff") {
			onExportTiff(ids, scale, profileValue);
		} else if (format === "svg") {
			onExportSVG(ids);
		}
		onOpenChange(false);
	});

	// Calculate output size for selected artboards
	const getOutputSize = useEventCallback((artboard: Artboard) => {
		// SVG output is vector: the viewBox always matches the artboard size.
		if (format === "svg") {
			const units = document?.units ?? DEFAULT_LENGTH_UNIT;
			return `${formatLength(artboard.width, units, 0)} × ${formatLength(artboard.height, units, 0)}${units}`;
		}
		if (isCustomDpi && !customDpiValid) return "—";
		return `${Math.round(artboard.width * scale)} × ${Math.round(artboard.height * scale)}px`;
	});

	const handleSetFormatPng = useEventCallback(() => setFormat("png"));
	const handleSetFormatJpeg = useEventCallback(() => setFormat("jpeg"));
	const handleSetFormatPsd = useEventCallback(() => setFormat("psd"));
	const handleSetFormatAvifHdr = useEventCallback(() => setFormat("avif-hdr"));
	const handleSetFormatTiff = useEventCallback(() => setFormat("tiff"));
	const handleSetFormatSvg = useEventCallback(() => setFormat("svg"));
	const handleSelectDpiPreset = useEventCallback((preset: number) => {
		setIsCustomDpi(false);
		setDpi(preset);
	});
	const handleSelectCustomDpi = useEventCallback(() => {
		setIsCustomDpi(true);
		setCustomDpiText(String(dpi));
	});
	const handleCustomDpiChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) =>
			setCustomDpiText(e.target.value),
	);
	const handleToggleArtboard = useEventCallback((id: string) =>
		handleToggle(id),
	);
	const handleRgbProfileChange = useEventCallback((value: string) =>
		setRgbProfileValue(value),
	);
	const handleJpegQualityChange = useEventCallback((value: number) =>
		setJpegQuality(value),
	);
	const handleTogglePsdIcc = useEventCallback((checked: boolean) =>
		setEmbedPsdIcc(checked),
	);
	const handleProfileSelect = useEventCallback(async (value: string) => {
		if (value.startsWith("system:")) {
			if (!paplico) return;
			const path = value.slice("system:".length);
			const entry = systemProfiles.find((p) => p.path === path);
			if (!entry) return;
			const embeddedFile = await createEmbeddedFileFromBytes(
				entry.bytes as Uint8Array<ArrayBuffer>,
				entry.description,
				"application/vnd.iccprofile",
			);
			const uid = paplico.commands.addEmbeddedFile(embeddedFile);
			setProfileValue(uid);
			return;
		}
		setProfileValue(value);
	});

	const handleLoadProfile = useEventCallback(async () => {
		if (!paplico) return;
		const handle = await FileSystem.openFileDialog({
			id: "tiff-color-profile",
			types: [...ICC_FILE_PICKER_TYPES],
		});
		if (!handle) return;

		const bin = new Uint8Array(await handle.file.arrayBuffer());
		if (!inspectIccProfile(bin)) {
			toastManager.add({
				title: t("exportDialog.invalidIccFile"),
				type: "warning",
			});
			return;
		}

		const embeddedFile = await createEmbeddedFileFromBytes(
			bin,
			handle.file.name,
			"application/vnd.iccprofile",
		);
		const uid = paplico.commands.addEmbeddedFile(embeddedFile);
		setProfileValue(uid);
	});

	const handleCancel = useEventCallback(() => onOpenChange(false));

	const titleKey =
		format === "png"
			? "exportDialog.pngExport"
			: format === "jpeg"
				? "exportDialog.jpegExport"
				: format === "psd"
					? "exportDialog.psdExport"
					: format === "avif-hdr"
						? "exportDialog.avifHdrExport"
						: format === "tiff"
							? "exportDialog.tiffExport"
							: "exportDialog.svgExport";

	const rgbProfileItems = [
		{ label: t("exportDialog.profileNone"), value: "" },
		...BUILTIN_ICC_PROFILES.map((p) => ({ label: p.label, value: p.id })),
		...rgbEmbeddedProfiles.map((f) => ({ label: f.name, value: f.uid })),
	];

	const tiffSystemProfiles = IS_TAURI_ENV
		? systemProfiles.filter(
				(p) => p.colorSpace === "rgb" || p.colorSpace === "cmyk",
			)
		: [];
	const hasExtraTiffProfiles =
		tiffEmbeddedProfiles.length > 0 || tiffSystemProfiles.length > 0;
	const tiffProfileItems = [
		{ label: t("exportDialog.profileNone"), value: "" },
		...BUILTIN_ICC_PROFILES.map((p) => ({ label: p.label, value: p.id })),
		...(hasExtraTiffProfiles
			? [{ separator: true as const, id: "sep-embedded" }]
			: []),
		...tiffEmbeddedProfiles.map((f) => ({ label: f.name, value: f.uid })),
		...tiffSystemProfiles.map((p) => ({
			label: p.description,
			value: `system:${p.path}`,
		})),
	];

	const showRgbProfile = format === "png" || format === "jpeg";
	const exportDisabled =
		selectedIds.size === 0 || (isCustomDpi && !customDpiValid);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[560px] max-h-[80vh] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t(titleKey)}
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
				<div className="flex-1 overflow-auto p-4 space-y-4">
					{/* Format Selector */}
					<div>
						<span className="text-xs text-muted-foreground block mb-2">
							{t("exportDialog.format")}
						</span>
						<div className="grid grid-cols-3 gap-2">
							<FormatButton
								active={format === "png"}
								onClick={handleSetFormatPng}
								label="PNG"
							/>
							<FormatButton
								active={format === "jpeg"}
								onClick={handleSetFormatJpeg}
								label={t("exportDialog.jpeg")}
							/>
							<FormatButton
								active={format === "psd"}
								onClick={handleSetFormatPsd}
								label="PSD (Photoshop)"
							/>
							<FormatButton
								active={format === "avif-hdr"}
								onClick={handleSetFormatAvifHdr}
								disabled={!isHdrEnabled}
								title={
									!isHdrEnabled
										? t("exportDialog.hdrDisabledTooltip")
										: undefined
								}
								label="AVIF (HDR)"
							/>
							<FormatButton
								active={format === "tiff"}
								onClick={handleSetFormatTiff}
								label={t("exportDialog.tiff")}
							/>
							<FormatButton
								active={format === "svg"}
								onClick={handleSetFormatSvg}
								label="SVG"
							/>
						</div>
					</div>

					{/* Resolution Selection (SVG rasterizes at the document's filter DPI) */}
					{format !== "psd" && format !== "svg" && (
						<div>
							<span className="text-xs text-muted-foreground block mb-2">
								{t("exportDialog.resolution")}
							</span>
							<div className="flex gap-2">
								{RASTERIZATION_DPI_PRESETS.map((preset) => (
									<button
										key={preset}
										type="button"
										onClick={() => handleSelectDpiPreset(preset)}
										className={twm(
											"flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors",
											"border",
											!isCustomDpi && dpi === preset
												? "border-primary bg-primary/10 text-primary"
												: "border-border/30 hover:bg-foreground/5",
										)}
									>
										{preset} dpi
									</button>
								))}
								<button
									type="button"
									onClick={handleSelectCustomDpi}
									className={twm(
										"flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors",
										"border",
										isCustomDpi
											? "border-primary bg-primary/10 text-primary"
											: "border-border/30 hover:bg-foreground/5",
									)}
								>
									{t("exportDialog.customResolution")}
								</button>
							</div>
							{isCustomDpi && (
								<div className="mt-2 w-[160px]">
									<Input
										$size="sm"
										type="number"
										min={1}
										unit="dpi"
										value={customDpiText}
										onChange={handleCustomDpiChange}
										aria-label={t("exportDialog.resolution")}
									/>
								</div>
							)}
						</div>
					)}

					{/* Color Profile (PNG / JPEG) */}
					{showRgbProfile && (
						<div className="flex items-center justify-between gap-4">
							<span className="text-xs text-muted-foreground shrink-0">
								{t("exportDialog.colorProfile")}
							</span>
							<SimpleSelect
								items={rgbProfileItems}
								value={rgbProfileValue}
								onValueChange={handleRgbProfileChange}
								className="w-[200px]"
							/>
						</div>
					)}

					{/* JPEG Quality */}
					{format === "jpeg" && (
						<>
							<div className="flex items-center justify-between gap-4">
								<div className="shrink-0">
									<div className="text-xs text-muted-foreground">
										{t("exportDialog.jpegQuality")}
									</div>
									<div className="text-[10px] text-muted-foreground mt-0.5">
										{Math.round(jpegQuality * 100)}%
									</div>
								</div>
								<Slider
									min={0.1}
									max={1.0}
									step={0.01}
									value={jpegQuality}
									onValueChange={handleJpegQualityChange}
									className="flex-1"
								/>
							</div>
							<div className="text-[10px] text-muted-foreground">
								{t("exportDialog.alphaFlattenNote")}
							</div>
						</>
					)}

					{/* PSD ICC Embed */}
					{format === "psd" && (
						// biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component
						<label className="flex items-center gap-2 cursor-pointer">
							<Checkbox
								checked={embedPsdIcc}
								onCheckedChange={handleTogglePsdIcc}
							/>
							<span className="text-xs text-muted-foreground">
								{t("exportDialog.embedIccProfile")}
							</span>
						</label>
					)}

					{/* TIFF Color Profile (RGB profile -> RGB TIFF, CMYK profile -> CMYK TIFF) */}
					{format === "tiff" && (
						<div className="space-y-2">
							<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
								<span className="text-xs text-muted-foreground shrink-0">
									{t("exportDialog.colorProfile")}
								</span>
								<div className="flex items-center gap-1">
									<SimpleCombobox
										items={tiffProfileItems}
										value={profileValue}
										onValueChange={handleProfileSelect}
										className="w-[200px]"
										$size="sm"
									/>
									<Tooltip content={t("exportDialog.loadIccFile")}>
										<IconButton
											$variant="secondary"
											$size="sm"
											onClick={handleLoadProfile}
											disabled={!paplico}
											aria-label={t("exportDialog.loadIccFile")}
										>
											<Upload size={14} />
										</IconButton>
									</Tooltip>
								</div>
							</div>
							{IS_TAURI_ENV && systemProfilesLoading && (
								<div className="text-[10px] text-muted-foreground">
									{t("exportDialog.loadingProfiles")}
								</div>
							)}
							<div className="text-[10px] text-muted-foreground">
								{t("exportDialog.alphaFlattenNote")}
							</div>
						</div>
					)}

					{/* Artboard Selection */}
					<div>
						<div className="flex items-center justify-between mb-2">
							<span className="text-xs text-muted-foreground">
								{t("exportDialog.artboard")}
							</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={handleSelectAll}
									className="text-xs text-primary hover:underline"
								>
									{t("exportDialog.selectAll")}
								</button>
								<button
									type="button"
									onClick={handleDeselectAll}
									className="text-xs text-muted-foreground hover:underline"
								>
									{t("exportDialog.deselectAll")}
								</button>
							</div>
						</div>

						<div className="grid grid-cols-4 gap-2">
							{artboards.map((artboard) => (
								// biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component
								<label
									key={artboard.id}
									className={twm(
										"flex flex-col gap-1.5 p-2 rounded-lg cursor-pointer",
										"border transition-colors",
										selectedIds.has(artboard.id)
											? "border-primary/50 bg-primary/5"
											: "border-border/30 hover:bg-foreground/5",
									)}
								>
									<div className="relative w-full aspect-square rounded bg-foreground/5 border border-border/20 flex items-center justify-center overflow-hidden">
										{thumbnails[artboard.id] ? (
											<img
												src={thumbnails[artboard.id]}
												alt={artboard.name}
												className="max-w-full max-h-full object-contain"
											/>
										) : (
											<ImageIcon
												size={16}
												className="text-muted-foreground/40 animate-pulse"
											/>
										)}
										<Checkbox
											checked={selectedIds.has(artboard.id)}
											onCheckedChange={() => handleToggleArtboard(artboard.id)}
											className="absolute top-1 left-1"
										/>
									</div>
									<div className="min-w-0">
										<div className="text-xs font-medium truncate">
											{artboard.name}
										</div>
										<div className="text-[10px] text-muted-foreground truncate">
											{getOutputSize(artboard)}
										</div>
									</div>
								</label>
							))}
						</div>
					</div>
				</div>

				{/* Footer */}
				<div className="flex items-center justify-between px-4 py-3 border-t border-border/30">
					<span className="text-xs text-muted-foreground">
						{t("exportDialog.selectedCount", {
							selected: String(selectedIds.size),
							total: String(artboards.length),
						})}
					</span>
					<div className="flex gap-2">
						<Button $variant="ghost" $size="sm" onClick={handleCancel}>
							{t("exportDialog.cancel")}
						</Button>
						<Button
							$variant="default"
							$size="sm"
							onClick={handleExport}
							disabled={exportDisabled}
						>
							<Download size={14} />
							{t("exportDialog.export")}
						</Button>
					</div>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});

function FormatButton({
	active,
	disabled,
	title,
	label,
	onClick,
}: {
	active: boolean;
	disabled?: boolean;
	title?: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={twm(
				"py-2 px-3 rounded-lg text-xs font-medium transition-colors",
				"border",
				active
					? "border-primary bg-primary/10 text-primary"
					: "border-border/30 hover:bg-foreground/5",
				disabled && "opacity-40 cursor-not-allowed",
			)}
		>
			{label}
		</button>
	);
}

/** Maps a RGB profile select value to a typed ICC export choice. */
function resolveRgbIccChoice(value: string): IccExportChoice {
	if (value === "") return { kind: "none" };
	if (BUILTIN_ICC_PROFILES.some((p) => p.id === value)) {
		return { kind: "builtin", id: value as BuiltinIccProfileId };
	}
	return { kind: "embedded", uid: value };
}
