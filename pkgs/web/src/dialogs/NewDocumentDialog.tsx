import { X } from "lucide-react";
import { useState } from "react";
import { createCallable } from "react-call";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Dialog } from "@/components/Dialog";
import { Input } from "@/components/Input";
import { FileSystem } from "@/infra/filesystem";
import { useTranslation } from "@/locales";
import { useEventCallback, useMediaDynamicRange } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

const DOCUMENT_PRESETS = [
	{
		key: "1920x1080",
		label: "1920 × 1080",
		sublabel: "FHD",
		width: 1920,
		height: 1080,
		category: "screen" as const,
	},
	{
		key: "1080x1080",
		label: "1080 × 1080",
		sublabel: "",
		width: 1080,
		height: 1080,
		category: "screen" as const,
	},
	{
		key: "1080x1920",
		label: "1080 × 1920",
		sublabel: "",
		width: 1080,
		height: 1920,
		category: "screen" as const,
	},
	{
		key: "3840x2160",
		label: "3840 × 2160",
		sublabel: "4K",
		width: 3840,
		height: 2160,
		category: "screen" as const,
	},
	{
		key: "a4-portrait",
		label: "A4",
		sublabel: "Portrait",
		width: 595,
		height: 842,
		category: "print" as const,
	},
	{
		key: "a4-landscape",
		label: "A4",
		sublabel: "Landscape",
		width: 842,
		height: 595,
		category: "print" as const,
	},
	{
		key: "a3-portrait",
		label: "A3",
		sublabel: "Portrait",
		width: 842,
		height: 1191,
		category: "print" as const,
	},
	{
		key: "letter",
		label: "US Letter",
		sublabel: "",
		width: 612,
		height: 792,
		category: "print" as const,
	},
] as const;

type PresetKey = (typeof DOCUMENT_PRESETS)[number]["key"];

type NewDocumentSizeResult =
	| {
			ok: true;
			size: { width: number; height: number } | null;
			imageFile?: File;
			hdr?: { enabled: boolean; exposure: number };
	  }
	| { ok: false };

export const NewDocumentDialog = createCallable<
	{ hdrSupported?: boolean },
	NewDocumentSizeResult
>(({ call, hdrSupported: hdrSupportedProp }) => {
	const t = useTranslation();
	const hdrSupported = hdrSupportedProp ?? false;
	const dynamicRange = useMediaDynamicRange();

	const [selectedPreset, setSelectedPreset] = useState<
		PresetKey | "custom" | "free"
	>("1920x1080");
	const [customWidth, setCustomWidth] = useState("1920");
	const [customHeight, setCustomHeight] = useState("1080");
	const [hdrEnabled, setHdrEnabled] = useState(false);

	const screenPresets = DOCUMENT_PRESETS.filter((p) => p.category === "screen");
	const printPresets = DOCUMENT_PRESETS.filter((p) => p.category === "print");

	const handleSelectPreset = useEventCallback(
		(preset: (typeof DOCUMENT_PRESETS)[number]) => {
			setSelectedPreset(preset.key);
			setCustomWidth(String(preset.width));
			setCustomHeight(String(preset.height));
		},
	);

	const handleDoubleClickPreset = useEventCallback(
		(preset: (typeof DOCUMENT_PRESETS)[number]) => {
			call.end({
				ok: true,
				size: { width: preset.width, height: preset.height },
			});
		},
	);

	const handleCustomWidthChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setCustomWidth(e.target.value);
			setSelectedPreset("custom");
		},
	);

	const handleCustomHeightChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setCustomHeight(e.target.value);
			setSelectedPreset("custom");
		},
	);

	const handleCreate = useEventCallback(() => {
		if (selectedPreset === "free") {
			call.end({
				ok: true,
				size: null,
				hdr: hdrEnabled ? { enabled: true, exposure: 0 } : undefined,
			});
			return;
		}

		let width: number;
		let height: number;

		if (selectedPreset === "custom") {
			width = Number(customWidth);
			height = Number(customHeight);
		} else {
			const preset = DOCUMENT_PRESETS.find((p) => p.key === selectedPreset)!;
			width = preset.width;
			height = preset.height;
		}

		call.end({
			ok: true,
			size: { width, height },
			hdr: hdrEnabled ? { enabled: true, exposure: 0 } : undefined,
		});
	});

	const handleLoadImage = useEventCallback(async () => {
		const handle = await FileSystem.openFileDialog({
			id: "document-image-import",
			types: [
				{
					description: "Image Files",
					accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp"] },
				},
			],
		});
		if (!handle) return;

		const bitmap = await createImageBitmap(handle.file);
		const { width, height } = bitmap;
		bitmap.close();

		call.end({
			ok: true,
			size: { width, height },
			imageFile: handle.file,
			hdr: hdrEnabled ? { enabled: true, exposure: 0 } : undefined,
		});
	});

	const handleCancel = useEventCallback(() => {
		call.end({ ok: false });
	});

	const isCreateDisabled =
		selectedPreset === "custom" &&
		(customWidth === "" ||
			customHeight === "" ||
			Number.isNaN(Number(customWidth)) ||
			Number.isNaN(Number(customHeight)) ||
			Number(customWidth) <= 0 ||
			Number(customHeight) <= 0);

	const handleSelectFree = useEventCallback(() => {
		setSelectedPreset("free");
	});

	const onOpenChange = useEventCallback(
		(open: boolean) => !open && call.end({ ok: false }),
	);

	const handlePresetClick = useEventCallback(
		(preset: (typeof DOCUMENT_PRESETS)[number]) => handleSelectPreset(preset),
	);

	const handlePresetDoubleClick = useEventCallback(
		(preset: (typeof DOCUMENT_PRESETS)[number]) =>
			handleDoubleClickPreset(preset),
	);

	const handleDoubleClickFree = useEventCallback(() => {
		call.end({ ok: true, size: null });
	});

	const handleSelectCustom = useEventCallback(() => {
		setSelectedPreset("custom");
	});

	const handleHdrCheckedChange = useEventCallback((checked: boolean) => {
		setHdrEnabled(checked);
	});

	return (
		<Dialog.Root open onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[480px] max-h-[80vh] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("newDocumentDialog.title")}
					</Dialog.Title>
					<Dialog.Close
						className={twm(
							"p-1 rounded hover:bg-foreground/10 transition-colors",
							"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
						)}
					>
						<X size={16} />
					</Dialog.Close>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-auto p-4 space-y-4">
					{/* Screen presets */}
					<div>
						<span className="text-xs text-muted-foreground block mb-2">
							{t("newDocumentDialog.screen")}
						</span>
						<div className="grid grid-cols-4 gap-2">
							{screenPresets.map((preset) => (
								<button
									key={preset.key}
									type="button"
									onClick={() => handlePresetClick(preset)}
									onDoubleClick={() => handlePresetDoubleClick(preset)}
									className={twm(
										"flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg text-xs transition-colors",
										"border",
										selectedPreset === preset.key
											? "border-border-active"
											: "border-border/30 hover:bg-foreground/5",
									)}
								>
									<AspectPreview width={preset.width} height={preset.height} />
									<span className="font-medium">{preset.label}</span>
									{preset.sublabel && (
										<span className="text-[10px] opacity-60">
											{preset.sublabel}
										</span>
									)}
								</button>
							))}
						</div>
					</div>

					{/* Print presets */}
					<div>
						<span className="text-xs text-muted-foreground block mb-2">
							{t("newDocumentDialog.print")}
						</span>
						<div className="grid grid-cols-4 gap-2">
							{printPresets.map((preset) => (
								<button
									key={preset.key}
									type="button"
									onClick={() => handlePresetClick(preset)}
									onDoubleClick={() => handlePresetDoubleClick(preset)}
									className={twm(
										"flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg text-xs transition-colors",
										"border",
										selectedPreset === preset.key
											? "border-border-active"
											: "border-border/30 hover:bg-foreground/5",
									)}
								>
									<AspectPreview width={preset.width} height={preset.height} />
									<span className="font-medium">{preset.label}</span>
									{preset.sublabel && (
										<span className="text-[10px] opacity-60">
											{preset.sublabel}
										</span>
									)}
								</button>
							))}
						</div>
					</div>

					{/* Other options */}
					<div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={handleSelectFree}
								onDoubleClick={handleDoubleClickFree}
								className={twm(
									"py-2 px-3 rounded-lg text-xs font-medium transition-colors border",
									selectedPreset === "free"
										? "border-border-active"
										: "border-border hover:bg-foreground/5",
								)}
							>
								{t("newDocumentDialog.freeSize")}
							</button>
							<button
								type="button"
								onClick={handleSelectCustom}
								className={twm(
									"py-2 px-3 rounded-lg text-xs font-medium transition-colors border",
									selectedPreset === "custom"
										? "border-border-active"
										: "border-border hover:bg-foreground/5",
								)}
							>
								{t("newDocumentDialog.custom")}
							</button>
							{selectedPreset === "custom" && (
								<>
									<Input
										$size="sm"
										className="w-20"
										value={customWidth}
										onChange={handleCustomWidthChange}
										placeholder={t("newDocumentDialog.width")}
									/>
									<span className="text-xs text-muted-foreground">×</span>
									<Input
										$size="sm"
										className="w-20"
										value={customHeight}
										onChange={handleCustomHeightChange}
										placeholder={t("newDocumentDialog.height")}
									/>
								</>
							)}
						</div>
					</div>

					{/* HDR Mode */}
					<div>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
						<label className="flex items-center gap-2 cursor-pointer">
							<Checkbox
								checked={hdrEnabled}
								onCheckedChange={handleHdrCheckedChange}
								disabled={!hdrSupported}
							/>
							<span className="text-xs font-medium">
								{t("newDocumentDialog.hdr")}
							</span>
							<span className="text-[10px] text-muted-foreground">
								{t("newDocumentDialog.hdrDescription")}
							</span>
						</label>
						{!hdrSupported && (
							<span className="text-[10px] text-destructive">
								{t("common.hdrNotSupported")}
							</span>
						)}
						{hdrSupported && dynamicRange !== "high" && (
							<span className="text-[10px] text-yellow-500">
								{t("common.hdrDisplayNotAvailable")}
							</span>
						)}
					</div>
				</div>

				{/* Footer */}
				<div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/30">
					<Button $variant="ghost" $size="sm" onClick={handleLoadImage}>
						{t("newDocumentDialog.loadImage")}
					</Button>
					<div className="flex items-center gap-2">
						<Button $variant="ghost" $size="sm" onClick={handleCancel}>
							{t("newDocumentDialog.cancel")}
						</Button>
						<Button
							$size="sm"
							onClick={handleCreate}
							disabled={isCreateDisabled}
						>
							{t("newDocumentDialog.create")}
						</Button>
					</div>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});

// -- Helper components --

function AspectPreview({ width, height }: { width: number; height: number }) {
	const maxSize = 32;
	const scale = maxSize / Math.max(width, height);
	const w = Math.round(width * scale);
	const h = Math.round(height * scale);

	return (
		<div
			className="border border-current/30 rounded-sm"
			style={{ width: w, height: h }}
		/>
	);
}
