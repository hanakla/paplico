import { Sparkles, X } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/Button";
import { CurveEditor, type CurvePoint } from "@/components/CurveEditor";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { Slider } from "@/components/Slider";
import { evaluatePiecewiseLinear } from "@/core/brush/curves";
import { BRUSH_INPUT_IDS } from "@/core/brush/inputs";
import { BRUSH_PROPERTY_REGISTRY } from "@/core/brush/properties";
import type {
	BrushCurve,
	BrushInputId,
	BrushPropertyConfig,
	BrushPropertyId,
} from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * One modulatable brush property: its base value, and which inputs bend it.
 *
 * A property with no curves reads as a plain slider; the influence button is
 * how the curve matrix is reached, and it carries a count so a brush that
 * responds to something is visibly different from one that does not.
 */
export const BrushPropertyRow = memo(function BrushPropertyRow({
	propertyId,
	config,
	onChange,
}: {
	propertyId: BrushPropertyId;
	config: BrushPropertyConfig | undefined;
	onChange: (propertyId: BrushPropertyId, next: BrushPropertyConfig) => void;
}) {
	const t = useTranslation();
	const spec = BRUSH_PROPERTY_REGISTRY[propertyId];
	const base = config?.base ?? spec.base;
	const curves = config?.curves ?? [];

	const replaceCurves = useEventCallback((next: BrushCurve[]) => {
		onChange(propertyId, {
			base,
			...(next.length > 0 ? { curves: next } : {}),
		});
	});

	const handleBaseChange = useEventCallback((value: number) => {
		onChange(propertyId, {
			base: value,
			...(curves.length > 0 ? { curves } : {}),
		});
	});

	const handleToggleInput = useEventCallback((input: BrushInputId) => {
		const existing = curves.find((curve) => curve.input === input);
		if (existing) {
			replaceCurves(curves.filter((curve) => curve.input !== input));
			return;
		}
		// A fresh curve starts flat at zero: adding an input must not change
		// what the brush already does until its curve is shaped.
		replaceCurves([
			...curves,
			{
				input,
				points: [
					[0, 0],
					[1, 0],
				],
			},
		]);
	});

	const handleCurveChange = useEventCallback(
		(input: BrushInputId, points: CurvePoint[]) => {
			replaceCurves(
				curves.map((curve) =>
					curve.input === input
						? {
								input,
								points: points.map((p) => [p.x, p.y] as [number, number]),
							}
						: curve,
				),
			);
		},
	);

	const uiRange = UI_RANGES[propertyId] ?? [spec.min, spec.max];
	// Curve output is a delta on the base, so the plot spans both directions of
	// the property's own range.
	const curveSpan = uiRange[1] - uiRange[0];

	return (
		<div className="flex items-center gap-3 px-3 py-1.5">
			<span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
				{t(`brushProperty.${propertyId}`)}
			</span>
			<Slider
				min={uiRange[0]}
				max={uiRange[1]}
				step={(uiRange[1] - uiRange[0]) / 200}
				value={base}
				onValueChange={handleBaseChange}
				className="flex-1"
			/>
			<span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
				{formatValue(base)}
			</span>
			<Popover.Root>
				<Popover.Trigger
					render={
						<IconButton
							$variant={curves.length > 0 ? "default" : "ghost"}
							$size="sm"
							aria-label={t("brushProperty.influences")}
						>
							<Sparkles size={14} />
							{curves.length > 0 && (
								<span className="ml-0.5 font-mono text-[10px]">
									{curves.length}
								</span>
							)}
						</IconButton>
					}
				/>
				<Popover.Content className="w-64 space-y-2 p-2">
					<div className="text-[11px] text-muted-foreground">
						{t("brushProperty.influencesDescription")}
					</div>
					<div className="flex flex-wrap gap-1">
						{BRUSH_INPUT_IDS.map((input) => (
							<InputToggle
								key={input}
								input={input}
								active={curves.some((curve) => curve.input === input)}
								onToggle={handleToggleInput}
							/>
						))}
					</div>

					{curves.map((curve) => (
						<InfluenceCurve
							key={curve.input}
							curve={curve}
							span={curveSpan}
							onChange={handleCurveChange}
							onRemove={handleToggleInput}
						/>
					))}
				</Popover.Content>
			</Popover.Root>
		</div>
	);
});

/**
 * Slider ranges for editing, where the clamp range is impractical to drag
 * across. The stored value is still only bounded by the registry clamp.
 */
const UI_RANGES: Partial<Record<BrushPropertyId, readonly [number, number]>> = {
	size: [0.5, 200],
	spacing: [0.01, 2],
	dabsPerSecond: [0, 200],
	angle: [-Math.PI, Math.PI],
};

function formatValue(value: number): string {
	return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

const InputToggle = memo(function InputToggle({
	input,
	active,
	onToggle,
}: {
	input: BrushInputId;
	active: boolean;
	onToggle: (input: BrushInputId) => void;
}) {
	const t = useTranslation();
	const handleClick = useEventCallback(() => {
		onToggle(input);
	});

	return (
		<Button
			$variant={active ? "default" : "ghost"}
			$size="sm"
			onClick={handleClick}
		>
			{t(`brushInput.${input}`)}
		</Button>
	);
});

const InfluenceCurve = memo(function InfluenceCurve({
	curve,
	span,
	onChange,
	onRemove,
}: {
	curve: BrushCurve;
	span: number;
	onChange: (input: BrushInputId, points: CurvePoint[]) => void;
	onRemove: (input: BrushInputId) => void;
}) {
	const t = useTranslation();

	const handleChange = useEventCallback((points: CurvePoint[]) => {
		onChange(curve.input, points);
	});

	const handleRemove = useEventCallback(() => {
		onRemove(curve.input);
	});

	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between">
				<span className="text-[11px] text-foreground">
					{t(`brushInput.${curve.input}`)}
				</span>
				<IconButton
					$variant="ghost"
					$size="sm"
					aria-label={t("brushProperty.removeInfluence")}
					onClick={handleRemove}
				>
					<X size={12} />
				</IconButton>
			</div>
			<CurveEditor
				value={curve.points.map(([x, y]) => ({ x, y }))}
				onChange={handleChange}
				evaluate={evaluateCurvePoints}
				yRange={[-span, span]}
				showIdentity={false}
				label={t(`brushInput.${curve.input}`)}
			/>
		</div>
	);
});

/** The runtime's interpolation, over the editor's point shape. */
function evaluateCurvePoints(points: readonly CurvePoint[], x: number): number {
	return evaluatePiecewiseLinear(
		points.map((p) => [p.x, p.y] as [number, number]),
		x,
	);
}
