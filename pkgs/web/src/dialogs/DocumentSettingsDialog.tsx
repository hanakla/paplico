"use client";

import { Info, Upload, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { SimpleCombobox } from "@/components/SimpleCombobox";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { Switch } from "@/components/Switch";
import { toastManager } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";
import { RASTERIZATION_DPI_PRESETS } from "@/configs";
import { inspectIccProfile } from "@/core/color/IccProfileRegistry";
import type { ProofProfileRef } from "@/core/color/types";
import { createEmbeddedFileFromBytes } from "@/core/document/factory";
import { createRendererState } from "@/core/document/rendererState";
import type { Paplico, PublicUIState } from "@/core/Paplico";
import type { EmbeddedFile } from "@/core/schema";
import { useSystemIccProfiles } from "@/hooks/useSystemIccProfiles";
import { BUILTIN_ICC_PROFILES } from "@/infra/builtinIccProfiles";
import { db } from "@/infra/documentDB";
import { FileSystem } from "@/infra/filesystem";
import { useTranslation } from "@/locales";
import { documentManagerState, renameDocument } from "@/stores/documentStore";
import { setSoftProofEnabled } from "@/stores/uiStore";
import { useEventCallback, useMediaDynamicRange } from "@/utils/hooks";
import { IS_TAURI_ENV } from "@/utils/platform";
import { twm } from "@/utils/tailwind";

const ICC_FILE_PICKER_TYPES: FilePickerAcceptType[] = [
	{
		description: "ICC Profile",
		accept: { "application/vnd.iccprofile": [".icc", ".icm"] },
	},
];

/**
 * Lists embedded ICC profiles usable for soft proof / CMYK selection. Lab/XYZ
 * (color space "other") are excluded because jscolorengine cannot load them,
 * so they would fail the soft-proof transform.
 */
function listIccProfiles(
	files: readonly EmbeddedFile[],
): { uid: string; name: string }[] {
	return files
		.filter((f) => {
			const colorSpace = inspectIccProfile(f.bin)?.colorSpace;
			return colorSpace != null && colorSpace !== "other";
		})
		.map((f) => ({ uid: f.uid, name: f.name }));
}

/** Typed stand-in while no Paplico instance is mounted: a pristine
 *  RendererState, so the snapshot keeps the real PublicUIState shape and the
 *  document fields need no casting. */
const FALLBACK_STATE: PublicUIState = createRendererState();

export const DocumentSettingsDialog = memo(function DocumentSettingsDialog({
	open,
	onOpenChange,
	paplico,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	paplico: Paplico | null;
}) {
	const t = useTranslation();
	const snap = useSnapshot(paplico?.uiState ?? FALLBACK_STATE);
	const docManagerSnap = useSnapshot(documentManagerState);
	const hdrEnabled = snap.document.hdr?.enabled ?? false;
	const hdrExposure = snap.document.hdr?.exposure ?? 0;
	const hdrSupported = snap.hdrSupported;
	const dynamicRange = useMediaDynamicRange();

	const colorProfile = snap.document.colorProfile;
	const workingSpace = colorProfile?.workingSpace ?? "display-p3";
	const proofProfile = colorProfile?.proofProfile;
	const rasterizationDpi = snap.document.rasterizationDpi ?? 72;
	const iccProfiles = listIccProfiles(snap.document.files);
	const selectedProofUid =
		proofProfile?.kind === "builtin"
			? proofProfile.id
			: proofProfile?.kind === "embedded"
				? proofProfile.fileUid
				: "";
	const { profiles: systemProfiles, loading: systemProfilesLoading } =
		useSystemIccProfiles();

	const [docName, setDocName] = useState("");

	// Rasterization DPI: preset dropdown + a custom numeric input revealed when
	// "Custom" is picked or the document holds a non-preset value.
	const [dpiCustomMode, setDpiCustomMode] = useState(false);
	const [dpiText, setDpiText] = useState("");
	const showDpiInput =
		dpiCustomMode || !RASTERIZATION_DPI_PRESETS.includes(rasterizationDpi);
	const dpiSelectValue = showDpiInput ? "custom" : String(rasterizationDpi);
	const parsedDpiInput = Number(dpiText);
	const canApplyDpi =
		Number.isFinite(parsedDpiInput) &&
		parsedDpiInput > 0 &&
		parsedDpiInput !== rasterizationDpi;

	useEffect(() => {
		if (!open || !docManagerSnap.currentDocumentId) return;
		db.documentMeta.get(docManagerSnap.currentDocumentId).then((meta) => {
			if (meta) setDocName(meta.name);
		});
	}, [open, docManagerSnap.currentDocumentId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: seed only on open; excluding rasterizationDpi keeps live edits from clobbering intermediate typing
	useEffect(() => {
		if (!open) return;
		setDpiCustomMode(false);
		setDpiText(String(rasterizationDpi));
	}, [open]);

	const handleNameChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setDocName(e.target.value);
		},
	);

	const handleNameBlur = useEventCallback(() => {
		const id = docManagerSnap.currentDocumentId;
		if (!id || !docName.trim()) return;
		renameDocument(id, docName.trim());
	});

	const handleToggleHdr = useEventCallback((checked: boolean) => {
		if (!paplico) return;
		paplico.commands.setHdr({ enabled: checked });
	});

	const handleExposureChange = useEventCallback((value: number) => {
		if (!paplico) return;
		paplico.commands.setHdr({ exposure: value });
	});

	const handleWorkingSpaceChange = useEventCallback((value: string) => {
		if (!paplico) return;
		paplico.commands.setColorProfile({
			workingSpace: value as "srgb" | "display-p3",
		});
	});

	const handleDpiSelectChange = useEventCallback((value: string) => {
		if (value === "custom") {
			setDpiCustomMode(true);
			setDpiText(String(rasterizationDpi));
			return;
		}
		setDpiCustomMode(false);
		paplico?.commands.setRasterizationDpi(Number(value));
	});

	// Custom DPI is not applied live; typing only updates the local buffer and the
	// value is committed when the Apply button is pressed.
	const handleCustomDpiInputChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setDpiText(e.target.value),
	);

	const handleApplyCustomDpi = useEventCallback(() => {
		const dpi = Number(dpiText);
		if (!Number.isFinite(dpi) || dpi <= 0) return;
		paplico?.commands.setRasterizationDpi(dpi);
	});

	const handleProofProfileSelect = useEventCallback(async (value: string) => {
		if (!paplico) return;

		// Empty value = "None": disable proofing and clear the profile.
		if (!value) {
			paplico.commands.setColorProfile({ proofProfile: undefined });
			await paplico.setSoftProof(false);
			setSoftProofEnabled(false);
			return;
		}

		let ref: ProofProfileRef;
		if (value === "srgb" || value === "display-p3") {
			ref = { kind: "builtin", id: value };
		} else if (value.startsWith("system:")) {
			const path = value.slice("system:".length);
			const entry = systemProfiles.find((p) => p.path === path);
			if (!entry) return;
			const embeddedFile = await createEmbeddedFileFromBytes(
				entry.bytes as Uint8Array<ArrayBuffer>,
				entry.description,
				"application/vnd.iccprofile",
			);
			const uid = paplico.commands.addEmbeddedFile(embeddedFile);
			ref = { kind: "embedded", fileUid: uid };
		} else {
			ref = { kind: "embedded", fileUid: value };
		}

		// Selecting a profile also turns proofing on (this picker replaced the
		// old on/off switch). setColorProfile updates the document synchronously
		// through the Yjs observer, so setSoftProof sees the new profile.
		paplico.commands.setColorProfile({ proofProfile: ref });
		try {
			const ok = await paplico.setSoftProof(true);
			setSoftProofEnabled(ok);
			if (!ok) {
				toastManager.add({
					title: t("documentSettings.loadCmykHint"),
					type: "warning",
				});
			}
		} catch (error) {
			console.error("Failed to enable soft proof:", error);
			setSoftProofEnabled(false);
			toastManager.add({
				title: t("documentSettings.loadCmykHint"),
				type: "warning",
			});
		}
	});

	const handleLoadIccProfile = useEventCallback(async () => {
		if (!paplico) return;
		const handle = await FileSystem.openFileDialog({
			id: "icc-profile",
			types: [...ICC_FILE_PICKER_TYPES],
		});
		if (!handle) return;

		const bin = new Uint8Array(await handle.file.arrayBuffer());
		if (!inspectIccProfile(bin)) {
			toastManager.add({
				title: t("documentSettings.invalidIccFile"),
				type: "warning",
			});
			return;
		}

		const embeddedFile = await createEmbeddedFileFromBytes(
			bin,
			handle.file.name,
			"application/vnd.iccprofile",
		);
		paplico.commands.addEmbeddedFile(embeddedFile);
	});

	const handleClose = useEventCallback(() => {
		onOpenChange(false);
	});

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[400px] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("documentSettings.title")}
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
				<div className="p-4 space-y-4">
					{/* Document Name */}
					<div>
						<div className="text-xs font-medium mb-1.5">
							{t("documentSettings.documentName")}
						</div>
						<Input
							$size="sm"
							value={docName}
							onChange={handleNameChange}
							onBlur={handleNameBlur}
							placeholder={t("documentSettings.documentNamePlaceholder")}
						/>
					</div>

					{/* HDR Setting */}
					<div className="flex items-center justify-between">
						<div>
							<div className="text-xs font-medium">
								{t("documentSettings.hdrEnabled")}
							</div>
							<div className="text-[10px] text-muted-foreground mt-0.5">
								{t("documentSettings.hdrDescription")}
							</div>
						</div>
						<Switch
							checked={hdrEnabled}
							onCheckedChange={handleToggleHdr}
							disabled={!paplico || !hdrSupported}
						/>
					</div>
					{!hdrSupported && (
						<div className="text-[10px] text-destructive">
							{t("common.hdrNotSupported")}
						</div>
					)}
					{hdrSupported && dynamicRange !== "high" && (
						<div className="text-[10px] text-yellow-500">
							{t("common.hdrDisplayNotAvailable")}
						</div>
					)}

					{/* HDR Exposure */}
					<div
						className={twm(
							"flex items-center justify-between gap-4",
							!hdrEnabled && "opacity-40 pointer-events-none",
						)}
					>
						<div className="shrink-0">
							<div className="text-xs font-medium">
								{t("documentSettings.hdrExposure")}
							</div>
							<div className="text-[10px] text-muted-foreground mt-0.5">
								{hdrExposure > 0
									? `+${hdrExposure.toFixed(1)}`
									: hdrExposure.toFixed(1)}{" "}
								EV
							</div>
						</div>
						<Slider
							min={0}
							max={4}
							step={0.1}
							value={hdrExposure}
							onValueChange={handleExposureChange}
							disabled={!hdrEnabled}
							className="flex-1"
						/>
					</div>

					{/* Color Section */}
					<div className="border-t border-border/30 pt-4 space-y-4">
						<div className="text-xs font-medium">
							{t("documentSettings.colorSection")}
						</div>

						{/* Working Color Space */}
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<div className="text-xs font-medium shrink-0">
								{t("documentSettings.workingSpace")}
							</div>
							<SimpleSelect
								$size="sm"
								items={[
									{ label: "sRGB", value: "srgb" },
									{ label: "Display P3", value: "display-p3" },
								]}
								value={workingSpace}
								onValueChange={handleWorkingSpaceChange}
								disabled={!paplico}
								className="w-[160px]"
							/>
						</div>

						{/* Print Color Preview (proof profile; picking one enables proofing) */}
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<div className="flex items-center gap-1 shrink-0">
								<div className="text-xs font-medium">
									{t("documentSettings.proofProfile")}
								</div>
								<Tooltip content={t("documentSettings.proofProfileHint")}>
									<Info
										size={13}
										className="text-muted-foreground cursor-help"
									/>
								</Tooltip>
							</div>
							<div className="flex items-center gap-1">
								<SimpleCombobox
									items={[
										{
											label: t("documentSettings.proofProfileNone"),
											value: "",
										},
										...BUILTIN_ICC_PROFILES.map((p) => ({
											label: p.label,
											value: p.id,
										})),
										...(iccProfiles.length > 0 ||
										(IS_TAURI_ENV &&
											systemProfiles.some((p) => p.colorSpace !== "other"))
											? [{ separator: true as const, id: "sep-embedded" }]
											: []),
										...iccProfiles.map((p) => ({
											label: p.name,
											value: p.uid,
										})),
										...(IS_TAURI_ENV
											? systemProfiles
													.filter((p) => p.colorSpace !== "other")
													.map((p) => ({
														label: p.description,
														value: `system:${p.path}`,
													}))
											: []),
									]}
									value={selectedProofUid}
									onValueChange={handleProofProfileSelect}
									disabled={!paplico}
									className="w-[160px]"
									$size="sm"
								/>
								<Tooltip content={t("documentSettings.loadIccProfile")}>
									<IconButton
										$variant="default"
										$size="sm"
										onClick={handleLoadIccProfile}
										disabled={!paplico}
										aria-label={t("documentSettings.loadIccProfile")}
									>
										<Upload size={14} />
									</IconButton>
								</Tooltip>
							</div>
						</div>

						{IS_TAURI_ENV && systemProfilesLoading && (
							<div className="text-[10px] text-muted-foreground text-right">
								{t("documentSettings.loadingProfiles")}
							</div>
						)}
					</div>

					{/* Rendering Section */}
					<div className="border-t border-border/30 pt-4 space-y-4">
						<div className="text-xs font-medium">
							{t("documentSettings.renderingSection")}
						</div>

						{/* Filter Rasterization Resolution */}
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<div className="flex items-center gap-1 shrink-0">
								<div className="text-xs font-medium">
									{t("documentSettings.rasterizationDpi")}
								</div>
								<Tooltip content={t("documentSettings.rasterizationDpiHint")}>
									<Info
										size={13}
										className="text-muted-foreground cursor-help"
									/>
								</Tooltip>
							</div>
							<div className="flex flex-col items-end gap-1.5">
								<SimpleSelect
									$size="sm"
									items={[
										...RASTERIZATION_DPI_PRESETS.map((d) => ({
											label: `${d} dpi`,
											value: String(d),
										})),
										{
											label: t("documentSettings.customResolution"),
											value: "custom",
										},
									]}
									value={dpiSelectValue}
									onValueChange={handleDpiSelectChange}
									disabled={!paplico}
									className="w-[160px]"
								/>
								{showDpiInput && (
									<div className="flex items-center gap-1.5">
										<div className="w-[100px]">
											<Input
												$size="sm"
												type="number"
												min={1}
												unit="dpi"
												value={dpiText}
												onChange={handleCustomDpiInputChange}
												disabled={!paplico}
												aria-label={t("documentSettings.rasterizationDpi")}
											/>
										</div>
										<Button
											$size="sm"
											$variant="default"
											onClick={handleApplyCustomDpi}
											disabled={!paplico || !canApplyDpi}
										>
											{t("documentSettings.apply")}
										</Button>
									</div>
								)}
							</div>
						</div>
					</div>
				</div>

				{/* Footer */}
				<div className="flex justify-end px-4 py-3 border-t border-border/30">
					<Button $variant="ghost" $size="sm" onClick={handleClose}>
						{t("documentSettings.close")}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});
