import { ArrowLeftRight, Plus, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import type {
	CompanionCommand,
	CompanionState,
} from "@/companion/companionProtocol";
import { Button } from "@/components/Button";
import { ColorPicker2 } from "@/components/ColorPicker2";
import { ToggleGroup } from "@/components/ToggleGroup";
import type {
	Color,
	ColorStop,
	FillColor,
	LinearGradient,
	RadialGradient,
	StrokeColor,
} from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { SliderRow } from "./SliderRow";

type ColorTarget = "stroke" | "fill";

/** What the remote can put in a slot. Anything else it can only report. */
type PaintKind = "none" | "solid" | "linear" | "radial";

export const ColorPane = memo(function ColorPane({
	state,
	onCommand,
}: {
	state: CompanionState;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();
	const [target, setTarget] = useState<ColorTarget>("stroke");
	const [stopIndex, setStopIndex] = useState(0);

	const paint: StrokeColor | FillColor | null =
		target === "stroke" ? state.strokeColor : state.fillColor;
	const kind = paintKindOf(paint);
	const gradient = gradientOf(paint);
	const stop = gradient?.stops[Math.min(stopIndex, gradient.stops.length - 1)];

	// The paint union only narrows by `target`, which the compiler cannot follow
	// across the two command shapes, so each branch asserts its own half.
	const send = useEventCallback((next: StrokeColor | FillColor | null) => {
		onCommand(
			target === "stroke"
				? { type: "setStrokeColor", color: next as StrokeColor | null }
				: { type: "setFillColor", color: next as FillColor | null },
		);
	});

	const handleTargetChange = useEventCallback((value: string[]) => {
		const next = value[0];
		if (next === "stroke" || next === "fill") {
			setTarget(next);
			setStopIndex(0);
		}
	});

	const handleKindChange = useEventCallback((value: string[]) => {
		const next = value[0] as PaintKind | undefined;
		if (!next || next === kind) return;
		setStopIndex(0);
		send(buildPaint(next, target, currentColorOf(paint)));
	});

	/** Edits the plain colour, or the chosen stop of a gradient. */
	const handleColorChange = useEventCallback((color: Color) => {
		if (!gradient) {
			send({ type: "solid", color });
			return;
		}
		send(withStops(paint, replaceAt(gradient.stops, stopIndex, { color })));
	});

	const handleStopOffsetChange = useEventCallback((offset: number) => {
		if (!gradient) return;
		send(withStops(paint, replaceAt(gradient.stops, stopIndex, { offset })));
	});

	const handleStopSelect = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			setStopIndex(Number(e.currentTarget.dataset.stopIndex));
		},
	);

	const handleAddStop = useEventCallback(() => {
		if (!gradient) return;
		const last = gradient.stops.at(-1);
		send(
			withStops(paint, [
				...gradient.stops,
				{
					offset: 1,
					midpoint: 0.5,
					color: last?.color ?? DEFAULT_PLAIN_COLOR,
				},
			]),
		);
		setStopIndex(gradient.stops.length);
	});

	const handleRemoveStop = useEventCallback(() => {
		// Two is the fewest a gradient can be made of.
		if (!gradient || gradient.stops.length <= 2) return;
		send(
			withStops(
				paint,
				gradient.stops.filter((_, index) => index !== stopIndex),
			),
		);
		setStopIndex(0);
	});

	const handleSwap = useEventCallback(() => {
		onCommand({ type: "swapColors" });
	});

	const editableColor = gradient ? stop?.color : currentColorOf(paint);

	return (
		<div className="flex flex-col gap-3 p-3">
			<div className="flex items-center gap-2">
				<ToggleGroup.Root
					className="flex-1 min-w-0 w-auto"
					value={[target]}
					onValueChange={handleTargetChange}
				>
					<ToggleGroup.Item
						className="flex-1 min-w-0 size-auto h-11 px-2 text-xs truncate"
						value="stroke"
					>
						{t("companion.strokeColor")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						className="flex-1 min-w-0 size-auto h-11 px-2 text-xs truncate"
						value="fill"
					>
						{t("companion.fillColor")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
				<Button
					$variant="secondary"
					$size="sm"
					className="size-11 shrink-0 justify-center"
					aria-label={t("companion.swapColors")}
					onClick={handleSwap}
				>
					<ArrowLeftRight size={16} />
				</Button>
			</div>

			<ToggleGroup.Root
				className="w-full"
				value={[kind]}
				onValueChange={handleKindChange}
			>
				<ToggleGroup.Item
					className="flex-1 min-w-0 size-auto h-11 px-1 text-xs truncate"
					value="none"
				>
					{t("toolbar.gradientNone")}
				</ToggleGroup.Item>
				<ToggleGroup.Item
					className="flex-1 min-w-0 size-auto h-11 px-1 text-xs truncate"
					value="solid"
				>
					{t("toolbar.gradientSolid")}
				</ToggleGroup.Item>
				<ToggleGroup.Item
					className="flex-1 min-w-0 size-auto h-11 px-1 text-xs truncate"
					value="linear"
				>
					{t("toolbar.gradientLinear")}
				</ToggleGroup.Item>
				{/* A stroke gradient is linear by definition in the schema. */}
				{target === "fill" && (
					<ToggleGroup.Item
						className="flex-1 min-w-0 size-auto h-11 px-1 text-xs truncate"
						value="radial"
					>
						{t("toolbar.gradientRadial")}
					</ToggleGroup.Item>
				)}
			</ToggleGroup.Root>

			{gradient && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<div className="flex flex-1 min-w-0 gap-1 overflow-x-auto">
							{gradient.stops.map((item, index) => (
								<button
									key={`${index}-${item.offset}`}
									type="button"
									data-stop-index={index}
									onClick={handleStopSelect}
									aria-label={`${t("toolbar.gradientStops")} ${index + 1}`}
									className={twm(
										"size-11 shrink-0 rounded-lg border-2",
										index === stopIndex ? "border-accent" : "border-border",
									)}
									style={{ background: cssColor(item.color) }}
								/>
							))}
						</div>
						<Button
							$variant="secondary"
							$size="sm"
							className="size-11 shrink-0 justify-center"
							aria-label={t("toolbar.addStop")}
							onClick={handleAddStop}
						>
							<Plus size={16} />
						</Button>
						<Button
							$variant="secondary"
							$size="sm"
							className="size-11 shrink-0 justify-center"
							aria-label={t("toolbar.removeStop")}
							disabled={gradient.stops.length <= 2}
							onClick={handleRemoveStop}
						>
							<Trash2 size={16} />
						</Button>
					</div>
					{stop && (
						<SliderRow
							label={t("toolbar.gradientMidpoint")}
							value={stop.offset}
							display={`${Math.round(stop.offset * 100)}%`}
							min={0}
							max={1}
							step={0.01}
							onValueChange={handleStopOffsetChange}
						/>
					)}
				</div>
			)}

			{editableColor ? (
				<ColorPicker2.Root
					color={editableColor}
					onColorChange={handleColorChange}
					touch
				>
					<div className="flex flex-col rounded-lg bg-popover overflow-hidden">
						<ColorPicker2.Saturation className="h-52" />
						<div className="flex flex-col gap-1 px-3 pt-2 pb-3">
							<ColorPicker2.ModeSliders />
							<ColorPicker2.Alpha />
							<div className="flex items-center justify-between pt-1">
								<ColorPicker2.ModeToggle />
								<ColorPicker2.HexInput />
							</div>
						</div>
					</div>
				</ColorPicker2.Root>
			) : (
				kind === "" && (
					<p className="text-xs text-muted-foreground px-1">
						{t("companion.colorNotAdjustable")}
					</p>
				)
			)}
		</div>
	);
});

/** Mid grey: visible against both a light and a dark canvas. */
const DEFAULT_PLAIN_COLOR: Color = {
	type: "rgb",
	r: 0.5,
	g: 0.5,
	b: 0.5,
	a: 1,
};

/** Empty for the paints placed on the canvas itself: patterns, free and mesh. */
function paintKindOf(paint: StrokeColor | FillColor | null): PaintKind | "" {
	if (!paint) return "none";
	if (paint.type === "solid") return "solid";
	if (paint.type === "linear" || paint.type === "stroke-gradient")
		return "linear";
	if (paint.type === "radial") return "radial";
	return "";
}

/** The gradient inside a paint, whichever slot it came from. */
function gradientOf(
	paint: StrokeColor | FillColor | null,
): LinearGradient | RadialGradient | null {
	if (!paint) return null;
	if (paint.type === "linear" || paint.type === "radial") return paint;
	if (paint.type === "stroke-gradient") return paint.gradient;
	return null;
}

function currentColorOf(paint: StrokeColor | FillColor | null): Color | null {
	if (paint?.type === "solid") return paint.color;
	return gradientOf(paint)?.stops[0]?.color ?? null;
}

function withStops(
	paint: StrokeColor | FillColor | null,
	stops: ColorStop[],
): StrokeColor | FillColor | null {
	if (!paint) return paint;
	if (paint.type === "linear" || paint.type === "radial")
		return { ...paint, stops };
	if (paint.type === "stroke-gradient")
		return { ...paint, gradient: { ...paint.gradient, stops } };
	return paint;
}

function replaceAt(
	stops: ColorStop[],
	index: number,
	patch: Partial<ColorStop>,
): ColorStop[] {
	return stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop));
}

/** A two-stop gradient carrying on from whatever colour was already there. */
function buildPaint(
	kind: PaintKind,
	target: ColorTarget,
	from: Color | null,
): StrokeColor | FillColor | null {
	if (kind === "none") return null;

	const color: Color = from ?? DEFAULT_PLAIN_COLOR;
	if (kind === "solid") return { type: "solid", color };

	const stops: ColorStop[] = [
		{ offset: 0, midpoint: 0.5, color },
		{ offset: 1, midpoint: 0.5, color: { ...color, a: 0 } },
	];

	if (kind === "radial") {
		return {
			type: "radial",
			cx: 0.5,
			cy: 0.5,
			radiusX: 0.5,
			radiusY: 0.5,
			rotation: 0,
			stops,
		};
	}

	const linear: LinearGradient = {
		type: "linear",
		x1: 0,
		y1: 0,
		x2: 1,
		y2: 0,
		stops,
	};
	return target === "stroke"
		? { type: "stroke-gradient", gradient: linear, mode: "within" }
		: linear;
}

function cssColor(color: Color): string {
	if (color.type === "rgb") {
		const to255 = (v: number) => Math.round(v * 255);
		return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${color.a})`;
	}
	return `hsla(${color.h * 360}deg, ${color.s * 100}%, ${color.v * 100}%, ${color.a})`;
}
