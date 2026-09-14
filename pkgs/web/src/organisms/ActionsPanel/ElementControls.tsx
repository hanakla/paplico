import {
	AlignCenter,
	AlignLeft,
	AlignRight,
	PilcrowLeft,
	TextCursorInput,
} from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { DashPatternControls } from "@/components/DashPatternControls";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Slider } from "@/components/Slider";
import { StrokeGeometryFields } from "@/components/StrokeGeometryFields";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import {
	mergeBrushStroking,
	readStoredBrushStroking,
	withStoredBrushSize,
} from "@/core/brush/access";
import type {
	AnyArtObject,
	BrushStroking,
	CompoundPath,
	Path,
	TextElement,
} from "@/core/schema";
import { getFirstStroke, getStrokeWidth } from "@/core/utils/elementQuery";
import { useActiveFontSettings } from "@/hooks/useCurrentFontSetting";
import { useFontPreview } from "@/hooks/useFontPreview";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { assertNonNull } from "@/utils/lang";
import { FontCombobox } from "./FontCombobox";
import { StrokeWidthField } from "./StrokeWidthField";
import { BRUSH_WIDTH_STEP, MIXED, resolveValue } from "./utils";

export const ElementControls = memo(function ElementControls({
	elements,
}: {
	elements: readonly AnyArtObject[];
}) {
	if (elements.length === 0) return null;

	const firstType = elements[0].type;

	if (firstType === "path" || firstType === "compound-path") {
		return (
			<StrokeWidthControl elements={elements as (Path | CompoundPath)[]} />
		);
	}

	if (firstType === "text") {
		const textElements = elements as TextElement[];
		return (
			<>
				<FontFamilyControl />
				<FontSizeControl />
				<div className="flex gap-2">
					<AlignmentControl elements={textElements} />
					<WritingModeControl elements={textElements} />
				</div>
			</>
		);
	}

	return null;
});

function StrokeWidthControl({
	elements,
}: {
	elements: (Path | CompoundPath)[];
}) {
	const t = useTranslation();
	const { uiState: store, commands } = usePaplico();
	const layerId = store.currentLayerId;

	const handleWidthChange = useEventCallback((value: number) => {
		assertNonNull(layerId);

		for (const el of elements) {
			const stroke = getFirstStroke(el.filters);
			const bs = stroke?.paramData.params.brushSettings;
			if (!stroke || !bs) continue;

			const newFilters = el.filters?.map((f) => {
				if (f !== stroke) return f;
				return {
					...f,
					paramData: {
						...f.paramData,
						params: {
							...stroke.paramData.params,
							brushSettings: withStoredBrushSize(bs, value),
						},
					},
				};
			});
			commands.updateElement(layerId, el.id, { filters: newFilters });
		}
	});

	const updateStrokingForAll = useEventCallback(
		(patch: Partial<BrushStroking>) => {
			assertNonNull(layerId);

			for (const el of elements) {
				const stroke = getFirstStroke(el.filters);
				const bs = stroke?.paramData.params.brushSettings;
				if (bs?.engine !== "geometric") continue;

				const prev = readStoredBrushStroking(bs);
				const newFilters = el.filters?.map((f) => {
					if (f !== stroke) return f;
					return {
						...f,
						paramData: {
							...f.paramData,
							params: {
								...stroke.paramData.params,
								brushSettings: {
									...bs,
									stroking: mergeBrushStroking(prev, patch),
								},
							},
						},
					};
				});
				commands.updateElement(layerId, el.id, { filters: newFilters });
			}
		},
	);

	if (!layerId) return null;

	const resolvedWidth = resolveValue(elements, (el) =>
		getStrokeWidth(el.filters),
	);
	const isMixed = resolvedWidth === MIXED;

	const firstStroke = getFirstStroke(elements[0]?.filters);
	const normalizedFirst = firstStroke?.paramData.params.brushSettings;
	const showStroking = normalizedFirst?.engine === "geometric";
	const stroking =
		normalizedFirst?.engine === "geometric"
			? normalizedFirst.stroking
			: undefined;

	return (
		<>
			<StrokeWidthField
				label={t("actionsPanel.strokeWidth")}
				value={isMixed ? 1 : resolvedWidth}
				isMixed={isMixed}
				min={0.5}
				max={100}
				range={100}
				step={BRUSH_WIDTH_STEP}
				onValueChange={handleWidthChange}
			/>

			{showStroking && (
				<>
					<StrokeGeometryFields
						stroking={stroking}
						onChange={updateStrokingForAll}
					/>

					<DashPatternControls
						stroking={stroking}
						strokeWidth={isMixed ? 1 : resolvedWidth}
						onChange={updateStrokingForAll}
					/>
				</>
			)}
		</>
	);
}

export function FontFamilyControl() {
	const t = useTranslation();
	const { fonts, isLoading, currentFont, isMixed, handleFontChange } =
		useActiveFontSettings();
	const { previewReady, previewRef } = useFontPreview();

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.font")}
			</span>
			<FontCombobox
				fonts={fonts}
				currentFont={currentFont}
				isLoading={isLoading}
				isMixed={isMixed}
				onFontChange={handleFontChange}
				previewReady={previewReady}
				previewRef={previewRef}
				placeholder={
					isLoading
						? t("actionsPanel.loading")
						: isMixed
							? t("actionsPanel.mixedBracket")
							: t("actionsPanel.selectFont")
				}
			/>
		</div>
	);
}

export function FontSizeControl() {
	const t = useTranslation();
	const { currentFontSize, isMixedSize, handleFontSizeChange } =
		useActiveFontSettings();

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.size")}
			</span>
			<div className="flex items-center gap-2 px-1">
				<Slider
					min={8}
					max={200}
					step={1}
					value={isMixedSize ? 24 : currentFontSize}
					onValueChange={handleFontSizeChange}
					className="w-full flex-1"
				/>
				<Input
					type="number"
					$size="xs"
					min="1"
					max="1000"
					step="1"
					value={isMixedSize ? "" : currentFontSize}
					onChange={(e) =>
						handleFontSizeChange(Number.parseFloat(e.target.value))
					}
					placeholder={isMixedSize ? t("actionsPanel.mixedBracket") : undefined}
					className="w-14"
				/>
			</div>
		</div>
	);
}

export function AlignmentControl({ elements }: { elements?: TextElement[] }) {
	const t = useTranslation();
	const { uiState: store, tools, commands } = usePaplico();
	const toolSnap = useSnapshot(tools.state);
	const layerId = store.currentLayerId;
	const hasElements = elements && elements.length > 0;

	const resolvedAlignment = hasElements
		? resolveValue(elements, (el) => {
				const firstPara = el.content.paragraphs[0];
				return firstPara?.alignment ?? "left";
			})
		: toolSnap.textDefaultAlignment;
	const isMixed = resolvedAlignment === MIXED;

	const handleChange = useEventCallback(
		(alignment: "left" | "center" | "right") => {
			tools.state.textDefaultAlignment = alignment;

			if (!hasElements || !layerId) return;

			for (const el of elements) {
				const updatedContent = {
					...el.content,
					paragraphs: el.content.paragraphs.map((para) => ({
						...para,
						alignment,
					})),
				};
				commands.updateElement(layerId, el.id, {
					content: updatedContent,
				});
			}
		},
	);

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.align")}
			</span>
			<div className="flex gap-1 px-1">
				<Tooltip content={t("actionsPanel.left")} side="bottom">
					<IconButton
						$size="xs"
						$variant={
							!isMixed && resolvedAlignment === "left" ? "default" : "ghost"
						}
						onClick={() => handleChange("left")}
					>
						<AlignLeft size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.center")} side="bottom">
					<IconButton
						$size="xs"
						$variant={
							!isMixed && resolvedAlignment === "center" ? "default" : "ghost"
						}
						onClick={() => handleChange("center")}
					>
						<AlignCenter size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.right")} side="bottom">
					<IconButton
						$size="xs"
						$variant={
							!isMixed && resolvedAlignment === "right" ? "default" : "ghost"
						}
						onClick={() => handleChange("right")}
					>
						<AlignRight size={14} />
					</IconButton>
				</Tooltip>
			</div>
			{isMixed && (
				<span className="text-[10px] text-muted-foreground px-1 italic">
					&lt;mixed&gt;
				</span>
			)}
		</div>
	);
}

export function WritingModeControl({ elements }: { elements?: TextElement[] }) {
	const t = useTranslation();
	const { uiState: store, tools, commands } = usePaplico();
	const toolSnap = useSnapshot(tools.state);
	const layerId = store.currentLayerId;
	const hasElements = elements && elements.length > 0;

	const resolvedVertical = hasElements
		? resolveValue(
				elements,
				(el) =>
					el.layout.writingMode === "vertical-rl" ||
					el.layout.writingMode === "vertical-lr",
			)
		: toolSnap.textDefaultWritingMode !== "horizontal-tb";
	const isMixed = resolvedVertical === MIXED;

	const handleChange = useEventCallback((vertical: boolean) => {
		const newMode = vertical ? "vertical-rl" : "horizontal-tb";
		tools.state.textDefaultWritingMode = newMode;

		if (!hasElements || !layerId) return;

		for (const el of elements) {
			commands.updateElement(layerId, el.id, {
				layout: { ...el.layout, writingMode: newMode },
			});
		}
	});

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.writingMode")}
			</span>
			<div className="flex gap-1 px-1">
				<Tooltip content={t("actionsPanel.horizontal")} side="bottom">
					<IconButton
						$size="xs"
						$variant={
							!isMixed && resolvedVertical === false ? "default" : "ghost"
						}
						onClick={() => handleChange(false)}
					>
						<TextCursorInput size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.vertical")} side="bottom">
					<IconButton
						$size="xs"
						$variant={
							!isMixed && resolvedVertical === true ? "default" : "ghost"
						}
						onClick={() => handleChange(true)}
					>
						<PilcrowLeft size={14} />
					</IconButton>
				</Tooltip>
			</div>
			{isMixed && (
				<span className="text-[10px] text-muted-foreground px-1 italic">
					&lt;mixed&gt;
				</span>
			)}
		</div>
	);
}
