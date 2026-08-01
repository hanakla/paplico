import { Plus, X } from "lucide-react";
import { memo } from "react";
import type { BrushStroking } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FakeInput } from "./FakeInput";
import { IconButton } from "./IconButton";
import { Slider } from "./Slider";
import { ToggleGroup } from "./ToggleGroup";

type DashPair = { dash: number; gap: number };

type DashPresetId = "solid" | "dashed" | "dotted" | "dash-dot";

type DashPatternControlsProps = {
	/** Normalized stroking settings; undefined when the brush is not geometric. */
	stroking: BrushStroking | undefined;
	/** Presets scale with this width; also used for the real-scale preview. */
	strokeWidth: number;
	disabled?: boolean;
	onChange: (patch: Partial<BrushStroking>) => void;
};

/**
 * Dash pattern editor: presets, dash/gap pair fields, offset slider and a
 * live preview. Emits partial BrushStroking patches; `dashArray: undefined`
 * in a patch means "dash off", which is what the leading preset sends.
 */
export const DashPatternControls = memo(function DashPatternControls({
	stroking,
	strokeWidth,
	disabled,
	onChange,
}: DashPatternControlsProps) {
	const t = useTranslation();

	const dashArray = stroking?.dashArray ?? [];
	const enabled = dashArray.length > 0;
	const dashOffset = stroking?.dashOffset ?? 0;
	const pairs = dashArrayToPairs(dashArray);
	const patternTotal = dashArray.reduce((a, b) => a + b, 0);
	const activePreset = matchDashPreset(dashArray, strokeWidth);

	const handlePresetChange = useEventCallback((values: string[]) => {
		const preset = values[0] as DashPresetId | undefined;
		if (!preset) return;
		if (preset === "solid") {
			onChange({ dashArray: undefined, dashOffset: undefined });
			return;
		}
		onChange({ dashArray: materializeDashPreset(preset, strokeWidth) });
	});

	const handleDashChange = useEventCallback((index: number, value: number) => {
		onChange({
			dashArray: pairsToDashArray(
				pairs.map((p, i) => (i === index ? { ...p, dash: value } : p)),
			),
		});
	});

	const handleGapChange = useEventCallback((index: number, value: number) => {
		onChange({
			dashArray: pairsToDashArray(
				pairs.map((p, i) => (i === index ? { ...p, gap: value } : p)),
			),
		});
	});

	const handleAddPair = useEventCallback(() => {
		const template = pairs.at(-1) ?? {
			dash: strokeWidth * 3,
			gap: strokeWidth * 2,
		};
		onChange({ dashArray: pairsToDashArray([...pairs, template]) });
	});

	const handleRemovePair = useEventCallback((index: number) => {
		onChange({
			dashArray: pairsToDashArray(pairs.filter((_, i) => i !== index)),
		});
	});

	const handleOffsetChange = useEventCallback((value: number) => {
		onChange({ dashOffset: value || undefined });
	});

	return (
		<div className="flex flex-col gap-2" data-disabled={disabled || undefined}>
			<div className="flex flex-col gap-1">
				<span className="text-muted-foreground text-[10px]">
					{t("filterPanel.dashPattern")}
				</span>
				<ToggleGroup.Root
					value={[activePreset ?? ""]}
					onValueChange={handlePresetChange}
					disabled={disabled}
				>
					<ToggleGroup.Item
						value="solid"
						className="h-6 w-auto px-1.5 text-[10px]"
					>
						{t("filterPanel.dashPresetNone")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="dashed"
						className="h-6 w-auto px-1.5"
						title={t("filterPanel.dashPresetDashed")}
					>
						<PresetLine dash="6 4" />
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="dotted"
						className="h-6 w-auto px-1.5"
						title={t("filterPanel.dashPresetDotted")}
					>
						<PresetLine dash="0.1 4" />
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="dash-dot"
						className="h-6 w-auto px-1.5"
						title={t("filterPanel.dashPresetDashDot")}
					>
						<PresetLine dash="6 4 0.1 4" />
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			{enabled && (
				<>
					<div className="flex flex-col gap-1">
						{pairs.map((pair, index) => (
							<DashPairRow
								// biome-ignore lint/suspicious/noArrayIndexKey: pairs have no identity beyond position
								key={index}
								index={index}
								pair={pair}
								disabled={disabled}
								canRemove={pairs.length > 1}
								onDashChange={handleDashChange}
								onGapChange={handleGapChange}
								onRemove={handleRemovePair}
								onAdd={index === pairs.length - 1 ? handleAddPair : undefined}
							/>
						))}
					</div>

					{patternTotal > 0 && (
						/* biome-ignore lint/a11y/noLabelWithoutControl: custom slider component */
						<label
							className="text-muted-foreground text-[10px] data-disabled:opacity-50"
							data-disabled={disabled || undefined}
						>
							<div>
								{t("filterPanel.dashOffset")}: {dashOffset.toFixed(1)}
							</div>
							<Slider
								min={0}
								max={patternTotal}
								step={0.5}
								value={dashOffset}
								onValueChange={handleOffsetChange}
								disabled={disabled}
							/>
						</label>
					)}
				</>
			)}
		</div>
	);
});

function PresetLine({ dash }: { dash: string | undefined }) {
	return (
		<svg viewBox="0 0 36 6" className="h-1.5 w-9" role="presentation">
			<line
				x1={2}
				y1={3}
				x2={34}
				y2={3}
				stroke="currentColor"
				strokeWidth={2}
				strokeLinecap="round"
				strokeDasharray={dash}
			/>
		</svg>
	);
}

const DashPairRow = memo(function DashPairRow({
	index,
	pair,
	disabled,
	canRemove,
	onDashChange,
	onGapChange,
	onRemove,
	onAdd,
}: {
	index: number;
	pair: DashPair;
	disabled?: boolean;
	canRemove: boolean;
	onDashChange: (index: number, value: number) => void;
	onGapChange: (index: number, value: number) => void;
	onRemove: (index: number) => void;
	/** Only the last row carries the add button, so it trails the list. */
	onAdd?: () => void;
}) {
	const t = useTranslation();

	const handleDash = useEventCallback((value: string | undefined) => {
		const parsed = parseDashInput(value, 0.1);
		if (parsed != null) onDashChange(index, parsed);
	});

	const handleGap = useEventCallback((value: string | undefined) => {
		const parsed = parseDashInput(value, 0);
		if (parsed != null) onGapChange(index, parsed);
	});

	const handleRemove = useEventCallback(() => {
		onRemove(index);
	});

	return (
		<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
			<span>{t("filterPanel.dashSegment")}</span>
			<FakeInput
				type="number"
				$size="xs"
				step={0.5}
				min={0.1}
				value={formatDashValue(pair.dash)}
				onChange={handleDash}
				disabled={disabled}
			/>
			<span>{t("filterPanel.dashGap")}</span>
			<FakeInput
				type="number"
				$size="xs"
				step={0.5}
				min={0}
				value={formatDashValue(pair.gap)}
				onChange={handleGap}
				disabled={disabled}
			/>
			<div className="ml-auto flex items-center gap-1.5">
				{onAdd && (
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={onAdd}
						disabled={disabled}
						title={t("filterPanel.dashAddPair")}
					>
						<Plus size={12} />
					</IconButton>
				)}
				<IconButton
					$size="xs"
					$variant="ghost"
					onClick={handleRemove}
					disabled={disabled || !canRemove}
					title={t("filterPanel.dashRemovePair")}
				>
					<X size={12} />
				</IconButton>
			</div>
		</div>
	);
});

/** Dash presets as stroke-width-relative coefficients (dash, gap, ...). */
export const DASH_PRESETS: readonly {
	id: Exclude<DashPresetId, "solid">;
	coefficients: readonly number[];
}[] = [
	{ id: "dashed", coefficients: [3, 2] },
	{ id: "dotted", coefficients: [0.5, 1.5] },
	{ id: "dash-dot", coefficients: [3, 1.5, 0.5, 1.5] },
];

/**
 * Splits a dashArray into dash/gap pairs. Odd-length arrays are doubled
 * first, matching the SVG spec and the renderer's applyDashPattern().
 */
export function dashArrayToPairs(dashArray: readonly number[]): DashPair[] {
	if (dashArray.length === 0) return [];
	const normalized =
		dashArray.length % 2 === 0 ? dashArray : [...dashArray, ...dashArray];
	const pairs: DashPair[] = [];
	for (let i = 0; i < normalized.length; i += 2) {
		pairs.push({ dash: normalized[i], gap: normalized[i + 1] });
	}
	return pairs;
}

export function pairsToDashArray(pairs: readonly DashPair[]): number[] {
	return pairs.flatMap((p) => [p.dash, p.gap]);
}

export function materializeDashPreset(
	preset: Exclude<DashPresetId, "solid">,
	strokeWidth: number,
): number[] {
	const found = DASH_PRESETS.find((p) => p.id === preset) ?? DASH_PRESETS[0];
	return found.coefficients.map((c) => roundDashValue(c * strokeWidth));
}

/**
 * Identifies which preset (if any) the current dashArray represents at the
 * given stroke width, within a 5% relative tolerance per entry.
 */
export function matchDashPreset(
	dashArray: readonly number[],
	strokeWidth: number,
): DashPresetId | null {
	if (dashArray.length === 0) return "solid";
	if (strokeWidth <= 0) return null;
	for (const preset of DASH_PRESETS) {
		if (preset.coefficients.length !== dashArray.length) continue;
		const matches = preset.coefficients.every((c, i) => {
			const expected = c * strokeWidth;
			return Math.abs(dashArray[i] - expected) <= expected * 0.05;
		});
		if (matches) return preset.id;
	}
	return null;
}

function parseDashInput(value: string | undefined, min: number): number | null {
	if (value == null) return null;
	const parsed = Number.parseFloat(value.trim());
	if (Number.isNaN(parsed)) return null;
	return Math.max(min, parsed);
}

function formatDashValue(value: number): string {
	return String(roundDashValue(value));
}

function roundDashValue(value: number): number {
	return Number(value.toFixed(4));
}
