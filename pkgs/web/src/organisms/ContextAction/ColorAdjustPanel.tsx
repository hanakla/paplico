import { memo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { ColorPicker2 } from "@/components/ColorPicker2";
import { Slider } from "@/components/Slider";
import type { AdjustColorSession } from "@/core/PaplicoCommands";
import { type Color, hsvToRgb } from "@/core/schema";
import {
	type CollectedColor,
	ColorAdjustStrategies,
	colorKey,
} from "@/core/utils/color";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const ColorAdjustPanel = memo(function ColorAdjustPanel({
	session,
	onCancel,
}: {
	session: AdjustColorSession;
	onCancel: () => void;
}) {
	const t = useTranslation();
	const [hue, setHue] = useState(0);
	const [sat, setSat] = useState(0);
	const [light, setLight] = useState(0);
	const [dotOffsets, setDotOffsets] = useState<Map<string, number>>(
		() => new Map(),
	);
	const [selectedDotKey, setSelectedDotKey] = useState<string | null>(null);
	const [absoluteOverrides, setAbsoluteOverrides] = useState<
		Map<string, Color>
	>(() => new Map());
	const [adjustedColors, setAdjustedColors] = useState<
		readonly CollectedColor[]
	>(() => session.collectedColors);

	const doPreview = useEventCallback(
		(
			h: number,
			s: number,
			l: number,
			hueOverrides: ReadonlyMap<string, number>,
			absOverrides: ReadonlyMap<string, Color>,
		) => {
			const hasHue = hueOverrides.size > 0;
			const hasAbs = absOverrides.size > 0;
			const needColors = hasHue || hasAbs;
			const newColors = session.preview(
				ColorAdjustStrategies.hsvAdjuster(
					h,
					s,
					l,
					hasHue ? hueOverrides : undefined,
					needColors ? session.collectedColors : undefined,
					hasAbs ? absOverrides : undefined,
				),
			);
			setAdjustedColors(newColors);
		},
	);

	const handleHueChange = useEventCallback((value: number) => {
		setHue(value);
		doPreview(value, sat, light, dotOffsets, absoluteOverrides);
	});

	const handleSatChange = useEventCallback((value: number) => {
		setSat(value);
		doPreview(hue, value, light, dotOffsets, absoluteOverrides);
	});

	const handleLightChange = useEventCallback((value: number) => {
		setLight(value);
		doPreview(hue, sat, value, dotOffsets, absoluteOverrides);
	});

	const handleDotHueChange = useEventCallback(
		(dotKey: string, offset: number) => {
			const next = new Map(dotOffsets);
			if (offset === 0) {
				next.delete(dotKey);
			} else {
				next.set(dotKey, offset);
			}
			setDotOffsets(next);
			doPreview(hue, sat, light, next, absoluteOverrides);
		},
	);

	const handleDotSelect = useEventCallback((key: string | null) => {
		setSelectedDotKey(key);
	});

	const handlePickerColorChange = useEventCallback((color: Color) => {
		if (!selectedDotKey) return;
		const next = new Map(absoluteOverrides);
		next.set(selectedDotKey, color);
		setAbsoluteOverrides(next);
		doPreview(hue, sat, light, dotOffsets, next);
	});

	const pickerColor = (() => {
		if (!selectedDotKey) return null;
		const abs = absoluteOverrides.get(selectedDotKey);
		if (abs) return abs;
		const cc = session.collectedColors.find(
			(c) => colorKey(c) === selectedDotKey,
		);
		return cc?.color ?? null;
	})();

	if (session.collectedColors.length === 0) {
		return (
			<p className="text-center text-sm text-muted-foreground">
				{t("actionsPanel.noColors")}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start gap-3">
				<ColorWheel
					collectedColors={session.collectedColors}
					adjustedColors={adjustedColors}
					hueShift={hue}
					dotOffsets={dotOffsets}
					selectedDotKey={selectedDotKey}
					onHueChange={handleHueChange}
					onDotHueChange={handleDotHueChange}
					onDotSelect={handleDotSelect}
				/>

				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<ColorPicker2.Root
						color={
							pickerColor ?? {
								type: "rgb",
								r: 0.5,
								g: 0.5,
								b: 0.5,
								a: 1,
							}
						}
						onColorChange={handlePickerColorChange}
						disabled={!selectedDotKey}
					>
						<div className="flex flex-col gap-1.5">
							<ColorPicker2.Hue />
							<ColorPicker2.SaturationSlider />
							<ColorPicker2.ValueSlider />
							<ColorPicker2.Alpha />
						</div>
					</ColorPicker2.Root>
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<SliderRow
					label={t("actionsPanel.hue")}
					value={hue}
					min={-180}
					max={180}
					onValueChange={handleHueChange}
				/>
				<SliderRow
					label={t("actionsPanel.saturation")}
					value={sat}
					min={-100}
					max={100}
					onValueChange={handleSatChange}
				/>
				<SliderRow
					label={t("actionsPanel.lightness")}
					value={light}
					min={-100}
					max={100}
					onValueChange={handleLightChange}
				/>
			</div>

			<div className="flex justify-end">
				<Button $variant="ghost" $size="sm" onClick={onCancel}>
					{t("actionsPanel.cancel")}
				</Button>
			</div>
		</div>
	);
});

// ============================================================
// Color Wheel
// ============================================================

const CLICK_THRESHOLD = 3;

const ColorWheel = memo(function ColorWheel({
	collectedColors,
	adjustedColors,
	hueShift,
	dotOffsets,
	selectedDotKey,
	onHueChange,
	onDotHueChange,
	onDotSelect,
}: {
	collectedColors: readonly CollectedColor[];
	adjustedColors: readonly CollectedColor[];
	hueShift: number;
	dotOffsets: ReadonlyMap<string, number>;
	selectedDotKey: string | null;
	onHueChange: (hue: number) => void;
	onDotHueChange: (dotKey: string, offset: number) => void;
	onDotSelect: (key: string | null) => void;
}) {
	const SIZE = 120;
	const R = SIZE / 2 - 8;
	const ringRef = useRef<HTMLDivElement>(null);

	const ringDragRef = useRef<{
		startAngle: number;
		startHue: number;
	} | null>(null);

	const dotDragRef = useRef<{
		dotKey: string;
		startAngle: number;
		startOffset: number;
		startClientX: number;
		startClientY: number;
		moved: boolean;
	} | null>(null);

	const getAngleFromPointer = useEventCallback(
		(e: React.PointerEvent | PointerEvent) => {
			const el = ringRef.current;
			if (!el) return 0;
			const rect = el.getBoundingClientRect();
			const dx = e.clientX - (rect.left + rect.width / 2);
			const dy = e.clientY - (rect.top + rect.height / 2);
			return Math.atan2(dy, dx);
		},
	);

	const handleRingPointerDown = useEventCallback((e: React.PointerEvent) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		ringDragRef.current = {
			startAngle: getAngleFromPointer(e),
			startHue: hueShift,
		};
	});

	const handleRingPointerMove = useEventCallback((e: React.PointerEvent) => {
		if (!ringDragRef.current) return;
		const currentAngle = getAngleFromPointer(e);
		let delta = currentAngle - ringDragRef.current.startAngle;
		if (delta > Math.PI) delta -= 2 * Math.PI;
		if (delta < -Math.PI) delta += 2 * Math.PI;
		const degreeDelta = (delta * 180) / Math.PI;
		const newHue = Math.max(
			-180,
			Math.min(180, Math.round(ringDragRef.current.startHue + degreeDelta)),
		);
		onHueChange(newHue);
	});

	const handleRingPointerUp = useEventCallback(() => {
		ringDragRef.current = null;
	});

	const handleDotPointerDown = useEventCallback(
		(e: React.PointerEvent, dotKey: string) => {
			e.stopPropagation();
			e.currentTarget.setPointerCapture(e.pointerId);
			dotDragRef.current = {
				dotKey,
				startAngle: getAngleFromPointer(e),
				startOffset: dotOffsets.get(dotKey) ?? 0,
				startClientX: e.clientX,
				startClientY: e.clientY,
				moved: false,
			};
		},
	);

	const handleDotPointerMove = useEventCallback((e: React.PointerEvent) => {
		const state = dotDragRef.current;
		if (!state) return;

		if (!state.moved) {
			const dx = e.clientX - state.startClientX;
			const dy = e.clientY - state.startClientY;
			if (Math.sqrt(dx * dx + dy * dy) < CLICK_THRESHOLD) return;
			state.moved = true;
		}

		const currentAngle = getAngleFromPointer(e);
		let delta = currentAngle - state.startAngle;
		if (delta > Math.PI) delta -= 2 * Math.PI;
		if (delta < -Math.PI) delta += 2 * Math.PI;
		const degreeDelta = (delta * 180) / Math.PI;
		const newOffset = Math.max(
			-180,
			Math.min(180, Math.round(state.startOffset + degreeDelta)),
		);
		onDotHueChange(state.dotKey, newOffset);
	});

	const handleDotPointerUp = useEventCallback(() => {
		const state = dotDragRef.current;
		if (!state) return;
		dotDragRef.current = null;

		if (!state.moved) {
			onDotSelect(selectedDotKey === state.dotKey ? null : state.dotKey);
		}
	});

	return (
		<div className="flex shrink-0 justify-center">
			<div
				ref={ringRef}
				className="relative cursor-grab active:cursor-grabbing"
				style={{ width: SIZE, height: SIZE }}
				onPointerDown={handleRingPointerDown}
				onPointerMove={handleRingPointerMove}
				onPointerUp={handleRingPointerUp}
			>
				<div
					className="pointer-events-none absolute inset-0 rounded-full"
					style={{
						background:
							"conic-gradient(hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%))",
						mask: "radial-gradient(circle, transparent 44px, black 44px)",
					}}
				/>
				{collectedColors.map((cc, i) => {
					const adjusted = adjustedColors[i];
					const displayColor = adjusted?.color ?? cc.color;
					const hsv = colorToDisplayHsv(displayColor);
					if (!hsv) return null;

					const key = colorKey(cc);
					const angle = (hsv[0] * 360 - 90) * (Math.PI / 180);
					const cx = SIZE / 2 + R * Math.cos(angle);
					const cy = SIZE / 2 + R * Math.sin(angle);
					const isSelected = selectedDotKey === key;

					return (
						<div
							key={key}
							className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full shadow-sm active:cursor-grabbing ${isSelected ? "size-4 border-3 border-white ring-2 ring-blue-400" : "size-3 border-2 border-white"}`}
							style={{
								left: cx,
								top: cy,
								backgroundColor: colorToCss(displayColor),
							}}
							onPointerDown={(e) => handleDotPointerDown(e, key)}
							onPointerMove={handleDotPointerMove}
							onPointerUp={handleDotPointerUp}
						/>
					);
				})}
			</div>
		</div>
	);
});

// ============================================================
// Slider Row
// ============================================================

const SliderRow = memo(function SliderRow({
	label,
	value,
	min,
	max,
	onValueChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	onValueChange: (value: number) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-8 shrink-0 text-xs text-muted-foreground">
				{label}
			</span>
			<Slider
				className="flex-1"
				min={min}
				max={max}
				step={1}
				value={value}
				onValueChange={onValueChange}
			/>
			<span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
				{value}
			</span>
		</div>
	);
});

// ============================================================
// Helpers
// ============================================================

function colorToDisplayHsv(
	color: CollectedColor["color"],
): [h: number, s: number, v: number] | null {
	if (color.type === "hsv") {
		return [color.h, color.s, color.v];
	}
	if (color.type === "rgb") {
		const max = Math.max(color.r, color.g, color.b);
		const min = Math.min(color.r, color.g, color.b);
		const d = max - min;
		const v = max;
		const s = max === 0 ? 0 : d / max;
		if (d === 0) return [0, s, v];
		let h: number;
		if (max === color.r)
			h = ((color.g - color.b) / d + (color.g < color.b ? 6 : 0)) / 6;
		else if (max === color.g) h = ((color.b - color.r) / d + 2) / 6;
		else h = ((color.r - color.g) / d + 4) / 6;
		return [h, s, v];
	}
	return null;
}

function colorToCss(color: CollectedColor["color"]): string {
	if (color.type === "rgb") {
		return `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`;
	}
	if (color.type === "hsv") {
		const [r, g, b] = hsvToRgb(color.h, color.s, color.v);
		return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
	}
	return "#888";
}
