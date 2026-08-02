import { useRef } from "react";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

interface HSVConditionParams {
	targetHue: number;
	hueRange: number;
	saturationMin: number;
	saturationMax: number;
	brightnessMin: number;
	brightnessMax: number;
}

/**
 * HSV target-condition editor for the color correction filter panel. The
 * hue is picked as a draggable band on a spectrum bar (drag inside to move,
 * drag edges to widen/narrow), and the saturation/brightness windows are
 * range bars with min/max handles.
 */
export function HSVConditionControls({
	params,
	onUpdate,
}: {
	params: HSVConditionParams;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);

	const handleHueChange = useEventCallback((hue: number, range: number) => {
		handleUpdate({ targetHue: hue, hueRange: range });
	});
	const handleSaturationChange = useEventCallback(
		(min: number, max: number) => {
			handleUpdate({ saturationMin: min, saturationMax: max });
		},
	);
	const handleBrightnessChange = useEventCallback(
		(min: number, max: number) => {
			handleUpdate({ brightnessMin: min, brightnessMax: max });
		},
	);

	const hue = wrapHue(params.targetHue);
	const vividColor = `hsl(${hue}, 100%, 50%)`;

	return (
		<div className="space-y-2 text-muted-foreground text-xs">
			<div>
				<div className="flex items-center justify-between mb-1">
					<span>{t("filterPanel.hsvCondTargetHue")}</span>
					<span>{`${Math.round(hue)}° ±${Math.round(params.hueRange)}°`}</span>
				</div>
				<HueBandBar
					hue={hue}
					range={params.hueRange}
					onChange={handleHueChange}
				/>
			</div>
			<div>
				<div className="flex items-center justify-between mb-1">
					<span>{t("filterPanel.hsvCondSaturation")}</span>
					<span>{formatRange(params.saturationMin, params.saturationMax)}</span>
				</div>
				<RangeBar
					min={params.saturationMin}
					max={params.saturationMax}
					trackCss={`linear-gradient(to right, hsl(${hue}, 0%, 50%), ${vividColor})`}
					onChange={handleSaturationChange}
				/>
			</div>
			<div>
				<div className="flex items-center justify-between mb-1">
					<span>{t("filterPanel.hsvCondBrightness")}</span>
					<span>{formatRange(params.brightnessMin, params.brightnessMax)}</span>
				</div>
				<RangeBar
					min={params.brightnessMin}
					max={params.brightnessMax}
					trackCss={`linear-gradient(to right, #000, ${vividColor})`}
					onChange={handleBrightnessChange}
				/>
			</div>
		</div>
	);
}

const HUE_TRACK_CSS =
	"linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

/** Screen-px tolerance for grabbing a band edge or a range handle. */
const EDGE_HIT_PX = 8;

/** Hue spectrum bar with a draggable target band (center move / edge resize). */
function HueBandBar({
	hue,
	range,
	onChange,
}: {
	hue: number;
	range: number;
	onChange: (hue: number, range: number) => void;
}) {
	const barRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		mode: "move" | "resize";
		grabOffset: number;
	} | null>(null);

	const hueAtEvent = useEventCallback((e: React.PointerEvent) => {
		const rect = barRef.current?.getBoundingClientRect();
		if (!rect) return hue;
		const ratio = Math.max(
			0,
			Math.min(1, (e.clientX - rect.left) / rect.width),
		);
		return ratio * 360;
	});

	const handlePointerDown = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const bar = barRef.current;
			if (!bar || dragRef.current) return;
			e.preventDefault();

			const hueAt = hueAtEvent(e);
			const edgeHitDeg =
				(EDGE_HIT_PX / bar.getBoundingClientRect().width) * 360;
			const distFromCenter = Math.abs(hueDelta(hue, hueAt));

			if (Math.abs(distFromCenter - range) <= edgeHitDeg) {
				dragRef.current = { mode: "resize", grabOffset: 0 };
			} else if (distFromCenter <= range) {
				dragRef.current = { mode: "move", grabOffset: hueDelta(hue, hueAt) };
			} else {
				// Clicking outside the band re-centers it at the clicked hue
				dragRef.current = { mode: "move", grabOffset: 0 };
				onChange(wrapHue(hueAt), range);
			}
			bar.setPointerCapture(e.pointerId);
		},
	);

	const handlePointerMove = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			if (!drag) return;
			// Self-heal when pointerup landed elsewhere and was never delivered
			if (e.buttons === 0) {
				dragRef.current = null;
				return;
			}
			const hueAt = hueAtEvent(e);

			if (drag.mode === "resize") {
				const newRange = Math.max(
					1,
					Math.min(180, Math.abs(hueDelta(hue, hueAt))),
				);
				onChange(hue, newRange);
				return;
			}
			onChange(wrapHue(hueAt - drag.grabOffset), range);
		},
	);

	const handlePointerUp = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const bar = barRef.current;
			if (bar?.hasPointerCapture(e.pointerId)) {
				bar.releasePointerCapture(e.pointerId);
			}
			dragRef.current = null;
		},
	);

	const start = wrapHue(hue - range);
	const widthDeg = Math.min(range * 2, 360);
	const segments = bandSegments(start, widthDeg);
	const endPos = wrapHue(hue + range);

	return (
		<div
			ref={barRef}
			className="relative h-6 cursor-ew-resize touch-none rounded border border-border"
			style={{ background: HUE_TRACK_CSS }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
		>
			{segments.map((seg) => (
				<div
					key={seg.left}
					className="pointer-events-none absolute inset-y-0 border-y-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
					style={{
						left: `${(seg.left / 360) * 100}%`,
						width: `${(seg.width / 360) * 100}%`,
					}}
				/>
			))}
			<BandGrip position={start / 360} />
			<BandGrip position={endPos / 360} />
		</div>
	);
}

/** Range bar with min/max handles over a gradient track (values 0..1). */
function RangeBar({
	min,
	max,
	trackCss,
	onChange,
}: {
	min: number;
	max: number;
	trackCss: string;
	onChange: (min: number, max: number) => void;
}) {
	const barRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		mode: "min" | "max" | "band";
		grabOffset: number;
	} | null>(null);

	const ratioAtEvent = useEventCallback((e: React.PointerEvent) => {
		const rect = barRef.current?.getBoundingClientRect();
		if (!rect) return 0;
		return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
	});

	const handlePointerDown = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const bar = barRef.current;
			if (!bar || dragRef.current) return;
			e.preventDefault();

			const r = ratioAtEvent(e);
			const handleHit = EDGE_HIT_PX / bar.getBoundingClientRect().width;

			if (
				Math.abs(r - min) <= handleHit &&
				Math.abs(r - min) <= Math.abs(r - max)
			) {
				dragRef.current = { mode: "min", grabOffset: 0 };
			} else if (Math.abs(r - max) <= handleHit) {
				dragRef.current = { mode: "max", grabOffset: 0 };
			} else if (r > min && r < max) {
				dragRef.current = { mode: "band", grabOffset: r - min };
			} else if (r < min) {
				dragRef.current = { mode: "min", grabOffset: 0 };
				onChange(r, max);
			} else {
				dragRef.current = { mode: "max", grabOffset: 0 };
				onChange(min, r);
			}
			bar.setPointerCapture(e.pointerId);
		},
	);

	const handlePointerMove = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			if (!drag) return;
			// Self-heal when pointerup landed elsewhere and was never delivered
			if (e.buttons === 0) {
				dragRef.current = null;
				return;
			}
			const r = ratioAtEvent(e);

			if (drag.mode === "min") {
				onChange(Math.min(r, max), max);
				return;
			}
			if (drag.mode === "max") {
				onChange(min, Math.max(r, min));
				return;
			}
			const width = max - min;
			const newMin = Math.max(0, Math.min(1 - width, r - drag.grabOffset));
			onChange(newMin, newMin + width);
		},
	);

	const handlePointerUp = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const bar = barRef.current;
			if (bar?.hasPointerCapture(e.pointerId)) {
				bar.releasePointerCapture(e.pointerId);
			}
			dragRef.current = null;
		},
	);

	return (
		<div
			ref={barRef}
			className="relative h-4 cursor-ew-resize touch-none rounded border border-border"
			style={{ background: trackCss }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
		>
			{/* Dim the excluded parts so the selected window reads at a glance */}
			<div
				className="pointer-events-none absolute inset-y-0 left-0 rounded-l bg-background/70"
				style={{ width: `${min * 100}%` }}
			/>
			<div
				className="pointer-events-none absolute inset-y-0 right-0 rounded-r bg-background/70"
				style={{ width: `${(1 - max) * 100}%` }}
			/>
			<BandGrip position={min} />
			<BandGrip position={max} />
		</div>
	);
}

/** Vertical grab handle drawn at a 0..1 horizontal position. */
function BandGrip({ position }: { position: number }) {
	return (
		<div
			className="pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 rounded bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
			style={{ left: `${position * 100}%` }}
		/>
	);
}

function wrapHue(h: number): number {
	return ((h % 360) + 360) % 360;
}

/** Signed shortest angular distance from one hue to another (-180..180). */
function hueDelta(from: number, to: number): number {
	return ((to - from + 540) % 360) - 180;
}

/** Split a possibly-wrapping hue band into renderable segments (degrees). */
function bandSegments(
	start: number,
	widthDeg: number,
): { left: number; width: number }[] {
	if (widthDeg >= 360) return [{ left: 0, width: 360 }];
	if (start + widthDeg <= 360) return [{ left: start, width: widthDeg }];
	return [
		{ left: start, width: 360 - start },
		{ left: 0, width: start + widthDeg - 360 },
	];
}

function formatRange(min: number, max: number): string {
	return `${Math.round(min * 100)}%–${Math.round(max * 100)}%`;
}
