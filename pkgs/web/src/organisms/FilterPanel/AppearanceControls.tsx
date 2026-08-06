import { Brush } from "lucide-react";
import { memo, type ReactNode } from "react";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { DashPatternControls } from "@/components/DashPatternControls";
import { FakeInput } from "@/components/FakeInput";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { ToggleGroup } from "@/components/ToggleGroup";
import { usePaplico } from "@/contexts/PaplicoContext";
import { readStoredBrushSize, withStoredBrushSize } from "@/core/brush/access";
import { normalizeBrushSettingsV2 } from "@/core/brush/migrate";
import { resolveBrushRenderRoute } from "@/core/brush/renderRoute";
import type {
	BlendMode,
	BrushStroking,
	Color,
	FillAppearance,
	Filter,
	LineCap,
	LineJoin,
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

export const AppearanceBaseControls = memo(function AppearanceBaseControls({
	filter,
	index,
	children,
}: {
	filter: Filter;
	index: number;
	children?: ReactNode;
}) {
	const { commands } = usePaplico();
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
						commands.updateFilterForSelectedElement(index, {
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
						commands.updateFilterForSelectedElement(index, {
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
	const { commands } = usePaplico();
	const t = useTranslation();
	const fill = filter.paramData.params.fill;
	const handleUpdate = useEventCallback((c: Color) =>
		commands.updateFilterForSelectedElement(index, {
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
	const { commands, tools } = usePaplico();
	const t = useTranslation();
	const params = filter.paramData.params;
	const strokeColor = params.strokeColor;
	const handleColorUpdate = useEventCallback((c: Color) =>
		commands.updateFilterForSelectedElement(index, {
			params: {
				strokeColor: {
					...strokeColor,
					color: c,
				},
			},
		}),
	);

	const handleEditBrush = useEventCallback(() => {
		// Load this appearance's brush as the designer's working copy, then
		// bind the designer to this filter index so edits flow back here
		// instead of into the element's first stroke appearance.
		if (params.brushSettings) {
			// Loaded as stored, not through the legacy view: that view has
			// nowhere to hold curves, mixing or the wet layer, so opening the
			// designer on an appearance would strip them from it.
			tools.setBrushSettings(normalizeBrushSettingsV2(params.brushSettings));
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
							commands.updateFilterForSelectedElement(index, {
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
						commands.updateFilterForSelectedElement(index, {
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
				disabled={
					!params.brushSettings ||
					resolveBrushRenderRoute(params.brushSettings).settings.engine !==
						"geometric"
				}
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
	const { commands } = usePaplico();
	const t = useTranslation();

	const normalizedBrush = params.brushSettings
		? resolveBrushRenderRoute(params.brushSettings).settings
		: null;
	const stroking =
		normalizedBrush?.engine === "geometric"
			? normalizedBrush.stroking
			: undefined;
	const lineCap = stroking?.lineCap ?? "round";
	const lineJoin = stroking?.lineJoin ?? "round";
	const miterLimit = stroking?.miterLimit ?? 4;
	const dashArray = stroking?.dashArray ?? [];
	const dashOffset = stroking?.dashOffset ?? 0;

	const updateStroking = useEventCallback((patch: Partial<BrushStroking>) => {
		commands.updateFilterForSelectedElement(index, {
			params: {
				brushSettings: {
					...params.brushSettings,
					stroking: {
						lineCap,
						lineJoin,
						miterLimit,
						dashArray: dashArray.length ? dashArray : undefined,
						dashOffset: dashOffset || undefined,
						...patch,
					},
				},
			},
		});
	});

	const handleLineCapChange = useEventCallback((values: string[]) => {
		const value = values[0] as LineCap | undefined;
		if (!value) return;
		updateStroking({ lineCap: value });
	});

	const handleLineJoinChange = useEventCallback((values: string[]) => {
		const value = values[0] as LineJoin | undefined;
		if (!value) return;
		updateStroking({ lineJoin: value });
	});

	const handleMiterLimitChange = useEventCallback((val: number) => {
		updateStroking({ miterLimit: val });
	});

	return (
		<div className="flex flex-col gap-2" data-disabled={disabled || undefined}>
			<div className="flex flex-col gap-1">
				<span className="text-muted-foreground text-[10px]">
					{t("filterPanel.lineCap")}
				</span>
				<ToggleGroup.Root
					value={[lineCap]}
					onValueChange={handleLineCapChange}
					disabled={disabled}
				>
					<ToggleGroup.Item
						value="butt"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.capButt")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="round"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.capRound")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="square"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.capSquare")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			<div className="flex flex-col gap-1">
				<span className="text-muted-foreground text-[10px]">
					{t("filterPanel.joinType")}
				</span>
				<ToggleGroup.Root
					value={[lineJoin]}
					onValueChange={handleLineJoinChange}
					disabled={disabled}
				>
					<ToggleGroup.Item
						value="miter"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.joinMiter")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="round"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.joinRound")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="bevel"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.joinBevel")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			{lineJoin === "miter" && (
				/* biome-ignore lint/a11y/noLabelWithoutControl: custom slider component */
				<label className="text-muted-foreground text-xs data-disabled:opacity-50">
					<div>
						{t("filterPanel.miterLimit")}: {miterLimit.toFixed(1)}
					</div>
					<Slider
						min={1}
						max={10}
						step={0.5}
						value={miterLimit}
						onValueChange={handleMiterLimitChange}
						disabled={disabled}
					/>
				</label>
			)}

			<DashPatternControls
				stroking={stroking}
				strokeWidth={normalizedBrush?.size ?? 2}
				disabled={disabled}
				onChange={updateStroking}
			/>
		</div>
	);
});
