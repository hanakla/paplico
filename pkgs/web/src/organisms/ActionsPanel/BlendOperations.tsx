import {
	ArrowDownUp,
	ChartSpline,
	GitCommitHorizontal,
	Shuffle,
	Unlink,
} from "lucide-react";
import { memo, useId } from "react";
import { useSnapshot } from "valtio";
import { BezierCurveEditor } from "@/components/BezierCurveEditor";
import { Checkbox } from "@/components/Checkbox";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { toastManager } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoCommands, usePaplicoStore } from "@/contexts/PaplicoContext";
import { type BlendEasing, type BlendEasingNode, isBlend } from "@/core/schema";
import { createLinearBezierEasing } from "@/core/utils/bezierEasing";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Blend actions in the ActionsPanel. Because the panel only renders for a
 * uniform-type selection, this covers Create (all paths) and single-blend
 * editing. Mixed blend+path selections (Replace Spine) are handled in
 * ContextActions instead.
 */
export const BlendOperations = memo(function BlendOperations() {
	const t = useTranslation();
	const commands = usePaplicoCommands();
	const store = usePaplicoStore();
	const snap = useSnapshot(store);
	const tiltId = useId();

	const selectedElements = snap.selectedElementIds
		.map((id) => snap.document.objects[id])
		.filter((el) => el !== undefined);
	const blends = selectedElements.filter(isBlend);
	const sources = selectedElements.filter(
		(el) => el?.type === "path" || el?.type === "compound-path",
	);

	const canCreate = blends.length === 0 && sources.length >= 2;
	const hasBlend = blends.length > 0;
	const singleBlend = blends.length === 1 ? blends[0] : null;
	const stepsCount =
		singleBlend?.spacing.type === "steps" ? singleBlend.spacing.count : 5;

	const handleCreate = useEventCallback(() => {
		const result = commands.createBlendFromSelection();
		if (!result.ok && result.reason === "different-parent") {
			toastManager.add({
				title: t("contextActions.blendErrorTitle"),
				description: t("contextActions.blendErrorDifferentParent"),
			});
		}
	});

	const handleRelease = useEventCallback(() => {
		for (const blend of blends) commands.releaseBlend(blend.id);
	});

	const handleReverse = useEventCallback(() => {
		for (const blend of blends) commands.reverseBlend(blend.id);
	});

	const handleStepsChange = useEventCallback((value: number) => {
		if (!singleBlend) return;
		commands.updateBlendSpacing(singleBlend.id, {
			type: "steps",
			count: Math.max(0, Math.floor(value)),
		});
	});

	const handleModeChange = useEventCallback((mode: string) => {
		if (!singleBlend) return;
		if (mode === "distance") {
			commands.updateBlendSpacing(singleBlend.id, {
				type: "distance",
				spacing: 20,
			});
		} else if (mode === "smooth") {
			commands.updateBlendSpacing(singleBlend.id, { type: "smooth" });
		} else {
			commands.updateBlendSpacing(singleBlend.id, { type: "steps", count: 5 });
		}
	});

	const handleDistanceChange = useEventCallback((value: number) => {
		if (!singleBlend) return;
		commands.updateBlendSpacing(singleBlend.id, {
			type: "distance",
			spacing: Math.max(1, value),
		});
	});

	const handlePlacementEasingChange = useEventCallback(
		(easing: BlendEasing) => {
			if (!singleBlend) return;
			commands.updateBlendEasing(singleBlend.id, "placementEasing", easing);
		},
	);

	const handleAppearanceEasingChange = useEventCallback(
		(easing: BlendEasing) => {
			if (!singleBlend) return;
			commands.updateBlendEasing(singleBlend.id, "appearanceEasing", easing);
		},
	);

	const handleTiltChange = useEventCallback((checked: boolean) => {
		if (!singleBlend) return;
		commands.updateBlendTilt(singleBlend.id, checked);
	});

	if (!canCreate && !hasBlend) return null;

	return (
		<div className="flex flex-col gap-1.5 w-full">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.blend")}
			</span>
			<div className="flex gap-1">
				{canCreate && (
					<Tooltip content={t("contextActions.createBlend")} side="bottom">
						<IconButton $size="xs" $variant="ghost" onClick={handleCreate}>
							<Shuffle size={14} />
						</IconButton>
					</Tooltip>
				)}
				{hasBlend && (
					<>
						<Tooltip content={t("contextActions.reverseBlend")} side="bottom">
							<IconButton $size="xs" $variant="ghost" onClick={handleReverse}>
								<ArrowDownUp size={14} />
							</IconButton>
						</Tooltip>
						<Tooltip content={t("contextActions.releaseBlend")} side="bottom">
							<IconButton $size="xs" $variant="ghost" onClick={handleRelease}>
								<Unlink size={14} />
							</IconButton>
						</Tooltip>
					</>
				)}
			</div>
			{singleBlend && (
				<div className="flex flex-col gap-1.5 px-1">
					<SimpleSelect
						$size="sm"
						items={[
							{ label: t("actionsPanel.blendModeSteps"), value: "steps" },
							{
								label: t("actionsPanel.blendModeDistance"),
								value: "distance",
							},
							{ label: t("actionsPanel.blendModeSmooth"), value: "smooth" },
						]}
						value={singleBlend.spacing.type}
						onValueChange={handleModeChange}
					/>
					{singleBlend.spacing.type === "steps" && (
						<div className="flex items-center gap-2">
							<GitCommitHorizontal
								size={14}
								className="text-muted-foreground shrink-0"
							/>
							<Slider
								min={0}
								max={200}
								step={1}
								value={stepsCount}
								onValueChange={handleStepsChange}
								className="flex-1"
							/>
							<FakeInput
								$size="xs"
								type="number"
								step={1}
								min={0}
								max={200}
								value={String(stepsCount)}
								onChange={(v) => handleStepsChange(v ? Number(v) : 0)}
								className="w-10 text-right tabular-nums"
							/>
						</div>
					)}
					{singleBlend.spacing.type === "distance" && (
						<div className="flex items-center gap-2">
							<GitCommitHorizontal
								size={14}
								className="text-muted-foreground shrink-0"
							/>
							<FakeInput
								$size="xs"
								type="number"
								step={1}
								min={1}
								value={String(singleBlend.spacing.spacing)}
								onChange={(v) => handleDistanceChange(v ? Number(v) : 1)}
								className="w-12 text-right tabular-nums"
							/>
							<span className="text-[10px] text-muted-foreground">
								{t("actionsPanel.blendSpacing")}
							</span>
						</div>
					)}
					<EasingField
						label={t("actionsPanel.blendPlacementEasing")}
						value={singleBlend.placementEasing}
						onChange={handlePlacementEasingChange}
					/>
					<EasingField
						label={t("actionsPanel.blendAppearanceEasing")}
						value={singleBlend.appearanceEasing}
						onChange={handleAppearanceEasingChange}
					/>
					<label
						htmlFor={tiltId}
						className="flex items-center gap-2 text-[10px] text-muted-foreground cursor-pointer select-none"
					>
						<Checkbox
							id={tiltId}
							checked={singleBlend.tiltToSpine ?? false}
							onCheckedChange={handleTiltChange}
						/>
						{t("actionsPanel.blendTilt")}
					</label>
				</div>
			)}
		</div>
	);
});

/** Preset picker for one blend easing, with a curve editor for custom curves. */
const EasingField = memo(function EasingField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: BlendEasing;
	onChange: (easing: BlendEasing) => void;
}) {
	const t = useTranslation();

	const handleTypeChange = useEventCallback((type: BlendEasing["type"]) => {
		onChange(
			type === "custom"
				? { type, nodes: createLinearBezierEasing() }
				: { type },
		);
	});

	const handleCurveChange = useEventCallback((nodes: BlendEasingNode[]) => {
		onChange({ type: "custom", nodes });
	});

	return (
		<div className="flex flex-col gap-1">
			<span className="text-[10px] text-muted-foreground">{label}</span>
			<div className="flex items-center gap-1">
				<SimpleSelect
					$size="sm"
					className="flex-1"
					items={[
						{ label: t("actionsPanel.easingLinear"), value: "linear" },
						{ label: t("actionsPanel.easingEaseIn"), value: "ease-in" },
						{ label: t("actionsPanel.easingEaseOut"), value: "ease-out" },
						{ label: t("actionsPanel.easingEaseInOut"), value: "ease-in-out" },
						{ label: t("actionsPanel.easingCustom"), value: "custom" },
					]}
					value={value.type}
					onValueChange={handleTypeChange}
				/>
				{value.type === "custom" && (
					<Popover.Root>
						<Tooltip
							content={t("actionsPanel.blendEditEasingCurve")}
							side="bottom"
						>
							<Popover.Trigger
								render={
									<IconButton
										$size="xs"
										$variant="ghost"
										aria-label={t("actionsPanel.blendEditEasingCurve")}
									>
										<ChartSpline size={14} />
									</IconButton>
								}
							/>
						</Tooltip>
						<Popover.Content className="w-auto p-2">
							<div className="flex flex-col gap-2">
								<div className="pl-1 text-[11px] font-medium text-foreground">
									{label}
								</div>
								<BezierCurveEditor
									value={value.nodes}
									onChange={handleCurveChange}
									label={label}
								/>
							</div>
						</Popover.Content>
					</Popover.Root>
				)}
			</div>
		</div>
	);
});
