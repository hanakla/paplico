import { Brush } from "lucide-react";
import { memo, type ReactNode } from "react";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { DashPatternControls } from "@/components/DashPatternControls";
import { FakeInput } from "@/components/FakeInput";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { StrokeGeometryFields } from "@/components/StrokeGeometryFields";
import { usePaplico } from "@/contexts/PaplicoContext";
import {
	mergeBrushStroking,
	readStoredBrushSize,
	withStoredBrushSize,
} from "@/core/brush/access";
import type {
	BlendMode,
	BrushStroking,
	Color,
	FillAppearance,
	Filter,
	StrokeAppearance,
} from "@/core/schema";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { useTranslation } from "@/locales";
import {
	setBrushDesignerPanelOpen,
	setBrushDesignerTargetFilterIndex,
	setSelectedBrushPresetUid,
} from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { useAppearanceSurfaceClose } from "./AppearanceSurface";
import { useFilterStack } from "./FilterStackContext";

export const AppearanceBaseControls = memo(function AppearanceBaseControls({
	filter,
	index,
	children,
}: {
	filter: Filter;
	index: number;
	children?: ReactNode;
}) {
	const stack = useFilterStack();
	const t = useTranslation();
	const blendModeItems = useBlendModeItems();

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between text-muted-foreground text-xs">
				<span>{t("filterPanel.opacity")}</span>
				<FakeInput
					type="number"
					step={0.1}
					unit="%"
					$behaviour="click"
					$side="end"
					$size="xs"
					value={`${Math.round(filter.opacity * 100)}`}
					onChange={(val) => {
						if (val == null) return;
						const parsed = Number.parseFloat(val.trim());
						if (Number.isNaN(parsed)) return;
						const clamped = Math.min(100, Math.max(0, parsed));
						stack.updateFilter(index, {
							opacity: clamped / 100,
						});
					}}
				/>
			</div>

			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.blendMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={blendModeItems}
					value={filter.blendMode}
					onValueChange={(value) =>
						stack.updateFilter(index, {
							blendMode: value as BlendMode,
						})
					}
				/>
			</div>

			{children}
		</div>
	);
});

export const FillAppearanceControls = memo(function FillAppearanceControls({
	filter,
	index,
}: {
	filter: FillAppearance;
	index: number;
}) {
	const stack = useFilterStack();
	const t = useTranslation();
	const fill = filter.paramData.params.fill;
	const handleUpdate = useEventCallback((c: Color) =>
		stack.updateFilter(index, {
			params: {
				fill: {
					...fill,
					color: c,
				},
			},
		}),
	);

	return (
		<AppearanceBaseControls filter={filter} index={index}>
			{fill.type === "solid" ? (
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.fillColor")}
					</div>
					<ColorPickerThin color={fill.color} onColorChange={handleUpdate} />
				</div>
			) : (
				<div className="text-muted-foreground text-xs">
					{fill.type} gradient
				</div>
			)}
		</AppearanceBaseControls>
	);
});

export const StrokeAppearanceControls = memo(function StrokeAppearanceControls({
	filter,
	index,
}: {
	filter: StrokeAppearance;
	index: number;
}) {
	const { tools } = usePaplico();
	const stack = useFilterStack();
	const t = useTranslation();
	const params = filter.paramData.params;
	const strokeColor = params.strokeColor;
	const handleColorUpdate = useEventCallback((c: Color) =>
		stack.updateFilter(index, {
			params: {
				strokeColor: {
					...strokeColor,
					color: c,
				},
			},
		}),
	);

	const closeSurface = useAppearanceSurfaceClose();
	const handleEditBrush = useEventCallback(() => {
		closeSurface();
		// Load this appearance's brush as the designer's working copy, then
		// bind the designer to this filter index so edits flow back here
		// instead of into the element's first stroke appearance.
		if (params.brushSettings) {
			// Loaded as stored, not through the flat view: that view has nowhere
			// to hold curves, mixing or the wet layer, so opening the designer on
			// an appearance would strip them from it.
			tools.setBrushSettings(params.brushSettings);
		}
		setSelectedBrushPresetUid(null);
		setBrushDesignerTargetFilterIndex(index);
		setBrushDesignerPanelOpen(true);
	});

	return (
		<AppearanceBaseControls filter={filter} index={index}>
			{strokeColor.type === "solid" && (
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.strokeColor")}
					</div>
					<ColorPickerThin
						color={strokeColor.color}
						onColorChange={handleColorUpdate}
					/>
				</div>
			)}

			<div className="text-muted-foreground text-xs">
				<div className="flex items-center justify-between">
					<span>{t("filterPanel.width")}</span>
					<FakeInput
						type="number"
						step={0.1}
						$behaviour="click"
						$side="end"
						$size="xs"
						value={(readStoredBrushSize(params.brushSettings) ?? 1).toFixed(1)}
						onChange={(val) => {
							if (val == null) return;
							const parsed = Number.parseFloat(val.trim());
							if (Number.isNaN(parsed)) return;
							const clamped = Math.min(100, Math.max(0.5, parsed));
							if (!params.brushSettings) return;
							stack.updateFilter(index, {
								params: {
									brushSettings: withStoredBrushSize(
										params.brushSettings,
										clamped,
									),
								},
							});
						}}
					/>
				</div>
				<Slider
					min={0.5}
					max={100}
					step={0.5}
					value={readStoredBrushSize(params.brushSettings) ?? 1}
					onValueChange={(val) => {
						if (!params.brushSettings) return;
						stack.updateFilter(index, {
							params: {
								brushSettings: withStoredBrushSize(params.brushSettings, val),
							},
						});
					}}
				/>
			</div>

			<button
				type="button"
				className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
				onClick={handleEditBrush}
			>
				<Brush size={14} />
				{t("filterPanel.editBrush")}
			</button>

			<StrokeGeometryControls
				params={params}
				index={index}
				filter={filter}
				disabled={params.brushSettings?.engine !== "geometric"}
			/>
		</AppearanceBaseControls>
	);
});

export const StrokeGeometryControls = memo(function StrokeGeometryControls({
	params,
	index,
	filter: _filter,
	disabled,
}: {
	params: StrokeAppearance["paramData"]["params"];
	index: number;
	filter: StrokeAppearance;
	disabled: boolean;
}) {
	const stack = useFilterStack();
	const t = useTranslation();

	const stroking =
		params.brushSettings?.engine === "geometric"
			? params.brushSettings.stroking
			: undefined;
	const dashArray = stroking?.dashArray ?? [];
	const dashOffset = stroking?.dashOffset ?? 0;

	const updateStroking = useEventCallback((patch: Partial<BrushStroking>) => {
		stack.updateFilter(index, {
			params: {
				brushSettings: {
					...params.brushSettings,
					stroking: mergeBrushStroking(stroking, {
						dashArray: dashArray.length ? dashArray : undefined,
						dashOffset: dashOffset || undefined,
						...patch,
					}),
				},
			},
		});
	});

	return (
		<div className="flex flex-col gap-2" data-disabled={disabled || undefined}>
			<StrokeGeometryFields
				stroking={stroking}
				disabled={disabled}
				showMiterLimit
				onChange={updateStroking}
			/>

			<DashPatternControls
				stroking={stroking}
				strokeWidth={params.brushSettings?.properties.size?.base ?? 2}
				disabled={disabled}
				onChange={updateStroking}
			/>
		</div>
	);
});
