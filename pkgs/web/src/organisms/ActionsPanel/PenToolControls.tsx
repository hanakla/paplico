import { memo } from "react";
import { useSnapshot } from "valtio";
import { Checkbox } from "@/components/Checkbox";
import { DashPatternControls } from "@/components/DashPatternControls";
import { ToggleGroup } from "@/components/ToggleGroup";
import { usePaplico } from "@/contexts/PaplicoContext";
import { readStoredBrushSize } from "@/core/brush/access";
import { normalizeBrushSettings } from "@/core/brush/normalize";
import type { BrushStroking, LineCap, LineJoin } from "@/core/schema";
import { isGeometricBrush } from "@/core/schema";
import { appConfig } from "@/hooks/useAppConfig";
import { useBrushEdits } from "@/hooks/useBrushEdits";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { StrokeWidthField } from "./StrokeWidthField";
import { TaperRangeField } from "./TaperRangeField";
import { BRUSH_WIDTH_STEP } from "./utils";

export const PenToolControls = memo(function PenToolControls() {
	const t = useTranslation();
	const { tools, commands } = usePaplico();
	const brushEdits = useBrushEdits();
	const toolSnap = useSnapshot(tools.state);

	const rawBrush = toolSnap.strokeAppearance?.paramData.params.brushSettings;
	const normalizedBrush = rawBrush ? normalizeBrushSettings(rawBrush) : null;
	const isGeometric = normalizedBrush
		? isGeometricBrush(normalizedBrush)
		: false;
	const lineCap =
		normalizedBrush?.type === "stroke"
			? (normalizedBrush.stroking?.lineCap ?? "round")
			: "round";
	const lineJoin =
		normalizedBrush?.type === "stroke"
			? (normalizedBrush.stroking?.lineJoin ?? "round")
			: "round";

	const handleWidthChange = useEventCallback((value: number) => {
		brushEdits.setBrushSize(value);
	});

	const handleTaperChange = useEventCallback(
		(taperStart: number, taperEnd: number) => {
			tools.setBrushSettings({ taperStart, taperEnd });
			commands.updateSelectedElementsBrushSettings({
				...tools.brushSettings,
				taperStart,
				taperEnd,
			});
		},
	);

	const handleStabilizationChange = useEventCallback((value: number) => {
		tools.setStabilization(value);
	});

	const handleSmoothingMethodChange = useEventCallback((value: string[]) => {
		if (value.length > 0) {
			tools.setSmoothingMethod(
				value[0] as "smooth" | "pulled-string" | "inertia",
			);
		}
	});

	const handleOpacityChange = useEventCallback((value: number) => {
		brushEdits.setOpacity(value);
	});

	const updateStroking = useEventCallback((patch: Partial<BrushStroking>) => {
		const current = tools.brushSettings;
		if (current.type !== "stroke") return;
		const stroking: BrushStroking = {
			lineCap: current.stroking?.lineCap ?? "round",
			lineJoin: current.stroking?.lineJoin ?? "round",
			miterLimit: current.stroking?.miterLimit ?? 4,
			dashArray: current.stroking?.dashArray,
			dashOffset: current.stroking?.dashOffset,
			...patch,
		};
		tools.setBrushSettings({ stroking });
		// Keep the selected element in sync: drawing resolves its appearance
		// from the selection when one exists, and stroke completion syncs the
		// selection's appearance back into the tool settings.
		commands.updateSelectedElementsBrushSettings({ ...current, stroking });
	});

	const handleLineCapChange = useEventCallback((value: string[]) => {
		const cap = value[0] as LineCap | undefined;
		if (cap) updateStroking({ lineCap: cap });
	});

	const handleLineJoinChange = useEventCallback((value: string[]) => {
		const join = value[0] as LineJoin | undefined;
		if (join) updateStroking({ lineJoin: join });
	});

	const handleSelectStrokeToggle = useEventCallback((checked: boolean) => {
		tools.state.selectStrokeAfterDraw = checked;
		appConfig.selectStrokeAfterDraw = checked;
	});

	return (
		<div className="flex flex-col gap-2 w-full">
			<StrokeWidthField
				label={t("actionsPanel.brushWidth")}
				value={
					readStoredBrushSize(
						toolSnap.strokeAppearance?.paramData.params.brushSettings,
					) ?? 2
				}
				min={0.01}
				max={Infinity}
				range={50}
				step={BRUSH_WIDTH_STEP}
				onValueChange={handleWidthChange}
			/>
			<TaperRangeField
				startLabel={t("actionsPanel.taperStart")}
				endLabel={t("actionsPanel.taperEnd")}
				startValue={normalizedBrush?.taperStart ?? 0}
				endValue={normalizedBrush?.taperEnd ?? 0}
				min={0}
				max={1000}
				step={1}
				onValueChange={handleTaperChange}
			/>
			<StrokeWidthField
				label={t("actionsPanel.stabilization")}
				value={toolSnap.stabilization}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleStabilizationChange}
			/>
			<div className="flex flex-col gap-1">
				<span className="text-[10px] text-muted-foreground">
					{t("actionsPanel.smoothingMethod")}
				</span>
				<ToggleGroup.Root
					value={[toolSnap.smoothingMethod]}
					onValueChange={handleSmoothingMethodChange}
				>
					<ToggleGroup.Item
						value="smooth"
						className="h-5 w-auto px-1.5 text-[10px]"
					>
						{t("actionsPanel.smoothingSmooth")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="pulled-string"
						className="h-5 w-auto px-1.5 text-[10px]"
					>
						{t("actionsPanel.smoothingPulledString")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="inertia"
						className="h-5 w-auto px-1.5 text-[10px]"
					>
						{t("actionsPanel.smoothingInertia")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			<StrokeWidthField
				label={t("actionsPanel.opacity")}
				value={toolSnap.opacity}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleOpacityChange}
			/>

			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<Checkbox
					id="select-stroke-after-draw"
					checked={toolSnap.selectStrokeAfterDraw}
					onCheckedChange={(v) => handleSelectStrokeToggle(!!v)}
				/>
				<label htmlFor="select-stroke-after-draw" className="cursor-pointer">
					{t("actionsPanel.selectStrokeAfterDraw")}
				</label>
			</span>

			{isGeometric && (
				<>
					<div className="flex flex-col gap-1">
						<span className="text-[10px] text-muted-foreground">
							{t("filterPanel.lineCap")}
						</span>
						<ToggleGroup.Root
							value={[lineCap]}
							onValueChange={handleLineCapChange}
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
						<span className="text-[10px] text-muted-foreground">
							{t("filterPanel.joinType")}
						</span>
						<ToggleGroup.Root
							value={[lineJoin]}
							onValueChange={handleLineJoinChange}
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
							normalizedBrush?.type === "stroke"
								? normalizedBrush.stroking
								: undefined
						}
						strokeWidth={normalizedBrush?.size ?? 2}
						onChange={updateStroking}
					/>
				</>
			)}
		</div>
	);
});
