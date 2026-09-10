import {
	ArrowRight,
	Ban,
	Circle,
	Edit3,
	Grid3x3,
	Hexagon,
	LayoutGrid,
	Paintbrush,
	PlusSquare,
	Trash2,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { ColorPickerFull } from "@/components/ColorPicker2";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { Slider } from "@/components/Slider";
import { ToggleGroup } from "@/components/ToggleGroup";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import {
	type Color,
	type ColorStop,
	colorToRawRGBA,
	type DefEntry,
	type FillColor,
	type FreeGradient,
	generateUid,
	hsvToRgb,
	isFreeGradient,
	isLinearGradient,
	isMeshGradient,
	isRadialGradient,
	isSolidColor,
	type LinearGradient,
	type MeshGradient,
	type PatternFill,
	type RadialGradient,
	type RGBColor,
	rgbToHsv,
	type SolidColor,
	toRGBColor,
} from "@/core/schema";
import { sampleGradientColorAt } from "@/core/utils/gradientSampling";
import { usePatternDefs } from "@/hooks/usePatternDefs";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

// --- Types ---

interface GradientPickerProps {
	fill: FillColor | null;
	onFillChange: (fill: FillColor | null) => void;
	/** Restrict which fill types are shown. Default: all types */
	allowedTypes?: Array<
		"none" | "solid" | "linear" | "radial" | "free" | "mesh" | "pattern"
	>;
}

// --- Helpers ---

function rgbToHSVColor(r: number, g: number, b: number, a: number): Color {
	const [h, s, v] = rgbToHsv(r, g, b);
	return { type: "hsv", h, s, v, a };
}

function colorToCSS(c: Color): string {
	if (c.type === "rgb") {
		return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
	}
	const [r, g, b] = hsvToRgb(c.h, c.s, c.v);
	return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${c.a})`;
}

function stopsToCSS(stops: ColorStop[]): string {
	return stops
		.map((s) => `${colorToCSS(s.color)} ${s.offset * 100}%`)
		.join(", ");
}

/** Extract the first color from a FillColor as RGBColor */
function extractFirstRGB(fill: FillColor): RGBColor {
	if (isSolidColor(fill)) return toRGBColor(colorToRawRGBA(fill.color));
	if (isLinearGradient(fill) || isRadialGradient(fill)) {
		return fill.stops.length > 0
			? toRGBColor(colorToRawRGBA(fill.stops[0].color))
			: { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
	}
	// Free gradient: use first stop color
	if (isFreeGradient(fill) && fill.stops.length > 0) {
		return toRGBColor(colorToRawRGBA(fill.stops[0].color));
	}
	// Mesh gradient: use first vertex color
	if (isMeshGradient(fill) && fill.vertices.length > 0) {
		return toRGBColor(colorToRawRGBA(fill.vertices[0].color));
	}
	return { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
}

function createDefaultStops(baseColor: RGBColor): ColorStop[] {
	return [
		{ offset: 0, color: baseColor, midpoint: 0.5 },
		{
			offset: 1,
			color: rgbToHSVColor(1, 1, 1, 1),
			midpoint: 0.5,
		},
	];
}

function createDefaultMeshGradient(baseColor: RGBColor): MeshGradient {
	const white = rgbToHSVColor(1, 1, 1, 1);
	const mid = rgbToHSVColor(
		baseColor.r * 0.5 + 0.5,
		baseColor.g * 0.5 + 0.5,
		baseColor.b * 0.5 + 0.5,
		1,
	);
	// Vertices and the face run counter-clockwise on screen
	// (top-left → bottom-left → bottom-right → top-right), matching
	// Illustrator's mesh resolution order.
	return {
		type: "mesh",
		vertices: [
			{
				x: 0,
				y: 0,
				color: baseColor,
				colorMode: "explicit",
				handles: {},
			},
			{
				x: 0,
				y: 1,
				color: mid,
				colorMode: "explicit",
				handles: {},
			},
			{
				x: 1,
				y: 1,
				color: white,
				colorMode: "explicit",
				handles: {},
			},
			{
				x: 1,
				y: 0,
				color: mid,
				colorMode: "explicit",
				handles: {},
			},
		],
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

function createDefaultFreeGradient(baseColor: RGBColor): FreeGradient {
	const white = rgbToHSVColor(1, 1, 1, 1);
	const mid = rgbToHSVColor(
		baseColor.r * 0.5 + 0.5,
		baseColor.g * 0.5 + 0.5,
		baseColor.b * 0.5 + 0.5,
		1,
	);
	return {
		type: "free",
		stops: [
			{ id: generateUid("fgrad-stop", 10), x: 0.15, y: 0.15, color: baseColor },
			{ id: generateUid("fgrad-stop", 10), x: 0.85, y: 0.15, color: mid },
			{ id: generateUid("fgrad-stop", 10), x: 0.85, y: 0.85, color: white },
			{ id: generateUid("fgrad-stop", 10), x: 0.15, y: 0.85, color: mid },
		],
	};
}

function createDefaultPatternFill(): PatternFill {
	return {
		type: "pattern",
		defId: null,
		scaleX: 1,
		scaleY: 1,
		rotation: 0,
		offsetX: 0,
		offsetY: 0,
	};
}

const STOP_REMOVE_DRAG_DISTANCE_PX = 20;

// --- Component ---

export const GradientPicker = memo(GradientPickerRoot);

function GradientPickerRoot({
	fill,
	onFillChange,
	allowedTypes,
}: GradientPickerProps) {
	const t = useTranslation();
	const fillType = fill?.type ?? "none";

	const handleTypeChange = useEventCallback((values: string[]) => {
		const newType = values.at(0);
		if (!newType || newType === fillType) return;
		if (
			allowedTypes &&
			!allowedTypes.includes(newType as (typeof allowedTypes)[number])
		)
			return;

		const baseColor = fill
			? extractFirstRGB(fill)
			: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 };

		switch (newType) {
			case "none":
				onFillChange(null);
				break;
			case "solid":
				onFillChange({ type: "solid", color: baseColor });
				break;
			case "linear":
				onFillChange({
					type: "linear",
					x1: 0,
					y1: 0.5,
					x2: 1,
					y2: 0.5,
					stops: createDefaultStops(baseColor),
				});
				break;
			case "radial":
				onFillChange({
					type: "radial",
					cx: 0.5,
					cy: 0.5,
					radiusX: 0.5,
					radiusY: 0.5,
					rotation: 0,
					stops: createDefaultStops(baseColor),
				});
				break;
			case "free":
				onFillChange(createDefaultFreeGradient(baseColor));
				break;
			case "mesh":
				onFillChange(createDefaultMeshGradient(baseColor));
				break;
			case "pattern":
				onFillChange(createDefaultPatternFill());
				break;
		}
	});

	return (
		<div className="flex w-60 flex-col gap-3">
			{/* Type selector */}
			<div className="flex items-center gap-2">
				<ToggleGroup.Root
					value={[fillType]}
					onValueChange={handleTypeChange}
					className="flex-1"
				>
					{(!allowedTypes || allowedTypes.includes("none")) && (
						<Tooltip content={t("toolbar.gradientNone")}>
							<ToggleGroup.Item value="none">
								<Ban size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
					{(!allowedTypes || allowedTypes.includes("solid")) && (
						<Tooltip content={t("toolbar.gradientSolid")}>
							<ToggleGroup.Item value="solid">
								<Paintbrush size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
					{(!allowedTypes || allowedTypes.includes("linear")) && (
						<Tooltip content={t("toolbar.gradientLinear")}>
							<ToggleGroup.Item value="linear">
								<ArrowRight size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
					{(!allowedTypes || allowedTypes.includes("radial")) && (
						<Tooltip content={t("toolbar.gradientRadial")}>
							<ToggleGroup.Item value="radial">
								<Circle size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
					{(!allowedTypes || allowedTypes.includes("free")) && (
						<Tooltip content={t("toolbar.gradientFree")}>
							<ToggleGroup.Item value="free">
								<Grid3x3 size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
					{(!allowedTypes || allowedTypes.includes("mesh")) && (
						<Tooltip content={t("toolbar.gradientMesh")}>
							<ToggleGroup.Item value="mesh">
								<Hexagon size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
					{(!allowedTypes || allowedTypes.includes("pattern")) && (
						<Tooltip content={t("toolbar.fillPattern")}>
							<ToggleGroup.Item value="pattern">
								<LayoutGrid size={14} />
							</ToggleGroup.Item>
						</Tooltip>
					)}
				</ToggleGroup.Root>
			</div>

			{/* Content by type */}
			{fillType === "solid" && (
				<SolidEditor
					fill={fill as SolidColor | null}
					onFillChange={onFillChange}
				/>
			)}
			{(fillType === "linear" || fillType === "radial") && (
				<GradientEditor
					fill={fill as LinearGradient | RadialGradient}
					onFillChange={onFillChange}
				/>
			)}
			{fillType === "free" && <FreeEditor />}
			{fillType === "mesh" && <MeshEditor />}
			{fillType === "pattern" && (
				<PatternEditor
					fill={fill as PatternFill | null}
					onFillChange={onFillChange}
				/>
			)}
			{fillType === "none" && (
				<div className="flex flex-col items-center gap-2 rounded border border-dashed border-border p-4">
					<Ban size={24} className="text-muted-foreground" />
					<span className="text-xs text-muted-foreground">
						{t("toolbar.noColor")}
					</span>
				</div>
			)}
		</div>
	);
}

// --- Solid Editor ---

const SolidEditor = memo(function SolidEditor({
	fill,
	onFillChange,
}: {
	fill: SolidColor | null;
	onFillChange: (fill: FillColor | null) => void;
}) {
	const color = fill?.color ?? { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 };

	const handleColorChange = useEventCallback((color: Color) => {
		onFillChange({ type: "solid", color });
	});

	return (
		<ColorPickerFull
			color={color}
			onColorChange={handleColorChange}
			saturationHeight="h-40"
			className="shadow-none"
		/>
	);
});

// --- Gradient Editor (Linear / Radial) ---

const GradientEditor = memo(function GradientEditor({
	fill,
	onFillChange,
}: {
	fill: LinearGradient | RadialGradient;
	onFillChange: (fill: FillColor | null) => void;
}) {
	const handleStopsChange = useEventCallback((stops: ColorStop[]) => {
		onFillChange({ ...fill, stops });
	});

	return (
		<GradientStopsEditor
			stops={fill.stops}
			onStopsChange={handleStopsChange}
			previewShape={isLinearGradient(fill) ? "linear" : "radial"}
			enableMidpoint
		/>
	);
});

/**
 * Standalone gradient stops editor: preview bar and a draggable stop bar
 * (click empty space to add, drag off the bar to remove, click a stop to
 * edit its color in a popover). Operates on a plain ColorStop[] so it can
 * be reused outside of fill editing (e.g. gradient map filter).
 */
export const GradientStopsEditor = memo(function GradientStopsEditor({
	stops,
	onStopsChange,
	previewShape = "linear",
	maxStops,
	enableMidpoint = false,
}: {
	stops: ColorStop[];
	onStopsChange: (stops: ColorStop[]) => void;
	previewShape?: "linear" | "radial";
	maxStops?: number;
	/** Show and allow dragging the midpoint marker between adjacent stops. */
	enableMidpoint?: boolean;
}) {
	const t = useTranslation();
	const [selectedStopIdx, setSelectedStopIdx] = useState(0);
	const [stopPopoverOpen, setStopPopoverOpen] = useState(false);
	// Anchor is state (not a ref) so switching stops re-resolves the popover
	// position even while the popup stays mounted between close/reopen
	const [popoverAnchor, setPopoverAnchor] = useState<Element | null>(null);
	const barRef = useRef<HTMLDivElement>(null);
	// Stop index that got focused by the current press; the popover opens in
	// the click event. Opening earlier (pointerup) would let the same
	// gesture's trailing click be treated as an outside press and close it.
	const pendingStopClickRef = useRef<number | null>(null);
	const draggingRef = useRef<{
		idx: number;
		startX: number;
		startY: number;
		startOffset: number;
		moved: boolean;
		removedStop: ColorStop | null;
		/** Alt was held when the drag started on an existing stop */
		altDuplicate: boolean;
		/** Whether the Alt-duplicate has already been materialized for this drag */
		duplicated: boolean;
	} | null>(null);
	/** Index of the segment's left stop (stops[idx] ~ stops[idx+1]) being dragged. */
	const midpointDraggingRef = useRef<number | null>(null);

	const selectedStop = stops[selectedStopIdx] ?? stops[0];

	// Clamp selectedStopIdx when stops change
	useEffect(() => {
		if (selectedStopIdx >= stops.length) {
			setSelectedStopIdx(Math.max(0, stops.length - 1));
		}
	}, [stops.length, selectedStopIdx]);

	const updateStops = useEventCallback((newStops: ColorStop[]) => {
		const sorted = [...newStops].sort((a, b) => a.offset - b.offset);
		onStopsChange(sorted);
	});

	const handleBarPointerDown = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (draggingRef.current) return;
			const bar = barRef.current;
			if (!bar) return;

			const rect = bar.getBoundingClientRect();
			const clickOffset = Math.max(
				0,
				Math.min(1, (e.clientX - rect.left) / rect.width),
			);

			// Check if click is near an existing stop (within 16px screen distance)
			const hitThreshold = 16 / rect.width;
			let nearestIdx = -1;
			let nearestDist = Infinity;
			for (let i = 0; i < stops.length; i++) {
				const dist = Math.abs(stops[i].offset - clickOffset);
				if (dist < nearestDist) {
					nearestDist = dist;
					nearestIdx = i;
				}
			}

			if (nearestIdx >= 0 && nearestDist <= hitThreshold) {
				// Drag existing stop
				e.preventDefault();
				setSelectedStopIdx(nearestIdx);
				draggingRef.current = {
					idx: nearestIdx,
					startX: e.clientX,
					startY: e.clientY,
					startOffset: stops[nearestIdx].offset,
					moved: false,
					removedStop: null,
					altDuplicate: e.altKey,
					duplicated: false,
				};
				bar.setPointerCapture(e.pointerId);
				return;
			}

			// Check if click is near a midpoint marker (between two adjacent stops)
			if (enableMidpoint && stops.length >= 2) {
				const sorted = [...stops].sort((a, b) => a.offset - b.offset);
				let nearestMidIdx = -1;
				let nearestMidDist = Infinity;
				for (let i = 0; i < sorted.length - 1; i++) {
					const s0 = sorted[i];
					const s1 = sorted[i + 1];
					const midPos = s0.offset + s0.midpoint * (s1.offset - s0.offset);
					const dist = Math.abs(midPos - clickOffset);
					if (dist < nearestMidDist) {
						nearestMidDist = dist;
						nearestMidIdx = i;
					}
				}
				if (nearestMidIdx >= 0 && nearestMidDist <= hitThreshold) {
					e.preventDefault();
					midpointDraggingRef.current = stops.indexOf(sorted[nearestMidIdx]);
					bar.setPointerCapture(e.pointerId);
					return;
				}
			}

			// Add new stop at click position
			if (maxStops !== undefined && stops.length >= maxStops) return;
			const color = sampleGradientColorAt(stops, clickOffset);

			const newStops = [
				...stops,
				{ offset: clickOffset, color, midpoint: 0.5 },
			];
			const sortedNew = newStops.sort((a, b) => a.offset - b.offset);
			const newIdx = sortedNew.findIndex(
				(s) => s.offset === clickOffset && s.color === color,
			);
			const addedIdx = newIdx >= 0 ? newIdx : sortedNew.length - 1;
			updateStops(sortedNew);
			setSelectedStopIdx(addedIdx);
			pendingStopClickRef.current = addedIdx;
		},
	);

	const handleBarPointerMove = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const midIdx = midpointDraggingRef.current;
			if (midIdx != null) {
				if (e.buttons === 0) {
					midpointDraggingRef.current = null;
					return;
				}
				const bar = barRef.current;
				const s0 = stops[midIdx];
				if (!bar || !s0) return;

				const sorted = [...stops].sort((a, b) => a.offset - b.offset);
				const s1 = sorted[sorted.indexOf(s0) + 1];
				if (!s1) return;

				const rect = bar.getBoundingClientRect();
				const pointerOffset = Math.max(
					0,
					Math.min(1, (e.clientX - rect.left) / rect.width),
				);
				const range = s1.offset - s0.offset;
				const mp = range > 0 ? (pointerOffset - s0.offset) / range : 0.5;
				const clamped = Math.max(0.0001, Math.min(0.9999, mp));
				// No sort here — a midpoint drag never changes offset.
				onStopsChange(
					stops.map((s, i) => (i === midIdx ? { ...s, midpoint: clamped } : s)),
				);
				return;
			}

			const drag = draggingRef.current;
			if (!drag) return;

			// Self-heal when pointerup landed elsewhere and was never delivered
			if (e.buttons === 0) {
				draggingRef.current = null;
				return;
			}

			const bar = barRef.current;
			if (!bar) return;

			if (
				!drag.moved &&
				(Math.abs(e.clientX - drag.startX) > 3 ||
					Math.abs(e.clientY - drag.startY) > 3)
			) {
				drag.moved = true;

				if (drag.altDuplicate && !drag.duplicated) {
					drag.duplicated = true;
					const original = stops[drag.idx];
					if (original && (maxStops === undefined || stops.length < maxStops)) {
						// Leave the original stop in place and drag a duplicate
						// instead. Only materialize the duplicate here; the offset
						// update below runs against the still-stale `stops` prop,
						// so let the next pointermove (against the updated prop)
						// handle it.
						const duplicate = { ...original };
						const newStops = [...stops, duplicate];
						const sorted = [...newStops].sort((a, b) => a.offset - b.offset);
						const duplicateIdx = sorted.indexOf(duplicate);
						updateStops(newStops);
						setSelectedStopIdx(duplicateIdx);
						drag.idx = duplicateIdx;
						return;
					}
				}
			}

			const rect = bar.getBoundingClientRect();
			const deltaRatio = (e.clientX - drag.startX) / rect.width;
			const newOffset = Math.max(0, Math.min(1, drag.startOffset + deltaRatio));
			const isInsideBar = e.clientY >= rect.top && e.clientY <= rect.bottom;
			const isBeyondRemoveThreshold =
				e.clientY < rect.top - STOP_REMOVE_DRAG_DISTANCE_PX ||
				e.clientY > rect.bottom + STOP_REMOVE_DRAG_DISTANCE_PX;

			if (drag.removedStop) {
				if (!isInsideBar) {
					drag.removedStop = { ...drag.removedStop, offset: newOffset };
					return;
				}

				const restoredStop = { ...drag.removedStop, offset: newOffset };
				const restoredStops = [...stops, restoredStop];
				updateStops(restoredStops);

				const sortedRestoredStops = [...restoredStops].sort(
					(a, b) => a.offset - b.offset,
				);
				const restoredIdx = sortedRestoredStops.indexOf(restoredStop);
				if (restoredIdx >= 0) {
					setSelectedStopIdx(restoredIdx);
					drag.idx = restoredIdx;
				}
				drag.removedStop = null;
				return;
			}

			if (isBeyondRemoveThreshold && stops.length > 2) {
				const movingStop = stops[drag.idx];
				if (!movingStop) return;

				const newStops = stops.filter((_, i) => i !== drag.idx);
				updateStops(newStops);

				drag.removedStop = { ...movingStop, offset: newOffset };
				setSelectedStopIdx(Math.min(drag.idx, newStops.length - 1));
				return;
			}

			const newStops = stops.map((s, i) =>
				i === drag.idx ? { ...s, offset: newOffset } : s,
			);
			updateStops(newStops);

			// Track the new index after sorting
			const sorted = [...newStops].sort((a, b) => a.offset - b.offset);
			const movedStop = newStops[drag.idx];
			const newIdx = sorted.indexOf(movedStop);
			if (newIdx >= 0) {
				setSelectedStopIdx(newIdx);
				drag.idx = newIdx;
			}
		},
	);

	const handleBarPointerUp = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const bar = barRef.current;
			if (bar?.hasPointerCapture(e.pointerId)) {
				bar.releasePointerCapture(e.pointerId);
			}
			midpointDraggingRef.current = null;
			const drag = draggingRef.current;
			draggingRef.current = null;

			// A click on an existing stop (no drag) focuses it; the popover
			// itself opens in the click event
			if (drag && !drag.moved && !drag.removedStop) {
				pendingStopClickRef.current = drag.idx;
			}
		},
	);

	const handleBarClick = useEventCallback(() => {
		const idx = pendingStopClickRef.current;
		pendingStopClickRef.current = null;
		if (idx == null) return;
		const markers = barRef.current?.querySelectorAll("[data-stop-marker]");
		setPopoverAnchor(markers?.[idx] ?? barRef.current ?? null);
		setStopPopoverOpen(true);
	});

	/** Double-clicking a midpoint marker adds a new stop right there,
	 *  colored by sampling the gradient at that position. */
	const handleBarDoubleClick = useEventCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			if (!enableMidpoint || stops.length < 2) return;
			const bar = barRef.current;
			if (!bar) return;
			if (maxStops !== undefined && stops.length >= maxStops) return;

			const rect = bar.getBoundingClientRect();
			const clickOffset = Math.max(
				0,
				Math.min(1, (e.clientX - rect.left) / rect.width),
			);
			const hitThreshold = 16 / rect.width;

			const sorted = [...stops].sort((a, b) => a.offset - b.offset);
			let nearestMidIdx = -1;
			let nearestMidDist = Infinity;
			for (let i = 0; i < sorted.length - 1; i++) {
				const s0 = sorted[i];
				const s1 = sorted[i + 1];
				const midPos = s0.offset + s0.midpoint * (s1.offset - s0.offset);
				const dist = Math.abs(midPos - clickOffset);
				if (dist < nearestMidDist) {
					nearestMidDist = dist;
					nearestMidIdx = i;
				}
			}
			if (nearestMidIdx < 0 || nearestMidDist > hitThreshold) return;

			const s0 = sorted[nearestMidIdx];
			const s1 = sorted[nearestMidIdx + 1];
			const midOffset = s0.offset + s0.midpoint * (s1.offset - s0.offset);
			const color = sampleGradientColorAt(stops, midOffset);
			const newStops = [...stops, { offset: midOffset, color, midpoint: 0.5 }];
			const sortedNew = newStops.sort((a, b) => a.offset - b.offset);
			const newIdx = sortedNew.findIndex(
				(s) => s.offset === midOffset && s.color === color,
			);
			updateStops(sortedNew);
			setSelectedStopIdx(newIdx >= 0 ? newIdx : sortedNew.length - 1);
		},
	);

	const handleBarPointerCancel = useEventCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const bar = barRef.current;
			if (bar?.hasPointerCapture(e.pointerId)) {
				bar.releasePointerCapture(e.pointerId);
			}
			draggingRef.current = null;
			midpointDraggingRef.current = null;
			pendingStopClickRef.current = null;
		},
	);

	const handleRemoveStop = useEventCallback(() => {
		if (stops.length <= 2) return;
		const newStops = stops.filter((_, i) => i !== selectedStopIdx);
		updateStops(newStops);
		setSelectedStopIdx(Math.min(selectedStopIdx, newStops.length - 1));
	});

	const handleStopColorChange = useEventCallback((color: Color) => {
		const newStops = stops.map((s, i) =>
			i === selectedStopIdx ? { ...s, color } : s,
		);
		updateStops(newStops);
	});

	const handleStopMidpointChange = useEventCallback((midpoint: number) => {
		const newStops = stops.map((s, i) =>
			i === selectedStopIdx ? { ...s, midpoint } : s,
		);
		// No sort — offset unchanged.
		onStopsChange(newStops);
	});

	const gradientCSS =
		previewShape === "linear"
			? `linear-gradient(to right, ${stopsToCSS(stops)})`
			: `radial-gradient(circle at center, ${stopsToCSS(stops)})`;

	// Kept outside the render so the JSX below can index into the full sorted
	// array for each segment's right stop, not a sliced copy of it.
	const sortedForMidpoints =
		enableMidpoint && stops.length >= 2
			? [...stops].sort((a, b) => a.offset - b.offset)
			: null;

	return (
		<div className="flex flex-col gap-3">
			{/* Gradient preview bar */}
			<div
				className="h-6 rounded border border-border"
				style={{ background: gradientCSS }}
			/>

			{/* Stop editor bar */}
			<div className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">
					{t("toolbar.gradientStops")}
				</span>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven gradient editing surface */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer-driven gradient editing surface */}
				<div
					ref={barRef}
					className="relative h-6 cursor-crosshair touch-none rounded border border-border bg-[repeating-conic-gradient(#e0e0e0_0%_25%,#fff_0%_50%)] bg-[length:8px_8px]"
					onPointerDown={handleBarPointerDown}
					onPointerMove={handleBarPointerMove}
					onPointerUp={handleBarPointerUp}
					onPointerCancel={handleBarPointerCancel}
					onClick={handleBarClick}
					onDoubleClick={handleBarDoubleClick}
				>
					{/* Gradient overlay on checkerboard */}
					<div
						className="pointer-events-none absolute inset-0 rounded"
						style={{
							background: `linear-gradient(to right, ${stopsToCSS(stops)})`,
						}}
					/>

					{stops.map((stop, idx) => (
						<div
							key={`${idx}-${stop.offset.toFixed(4)}`}
							data-stop-marker
							className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
							style={{ left: `${stop.offset * 100}%` }}
						>
							<div
								className={`h-3 w-3 rotate-45 rounded-[1px] ring-1 ring-[rgba(0,0,0,0.3)] border-2 ${
									idx === selectedStopIdx
										? "border-accent ring-white"
										: "border-white"
								}`}
								style={{ backgroundColor: colorToCSS(stop.color) }}
							/>
						</div>
					))}

					{sortedForMidpoints?.slice(0, -1).map((s0, i) => {
						const s1 = sortedForMidpoints[i + 1];
						const pos = s0.offset + s0.midpoint * (s1.offset - s0.offset);
						return (
							<div
								key={`mid-${i}-${s0.offset.toFixed(4)}`}
								data-midpoint-marker
								className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
								style={{ left: `${pos * 100}%` }}
							>
								<div className="h-2 w-2 rounded-full border border-muted-foreground bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" />
							</div>
						);
					})}
				</div>
			</div>

			{/* Remove stop button */}
			{stops.length > 2 && (
				<div className="flex justify-end">
					<Tooltip content={t("toolbar.removeStop")}>
						<IconButton $variant="ghost" $size="xs" onClick={handleRemoveStop}>
							<Trash2 size={12} />
						</IconButton>
					</Tooltip>
				</div>
			)}

			{/* Color picker for the clicked stop, anchored to its marker */}
			<Popover.Root open={stopPopoverOpen} onOpenChange={setStopPopoverOpen}>
				<Popover.Content side="bottom" sideOffset={8} anchor={popoverAnchor}>
					{selectedStop && (
						<div className="w-60">
							<StopColorEditor
								key={selectedStopIdx}
								stop={selectedStop}
								onStopColorChange={handleStopColorChange}
								onMidpointChange={
									enableMidpoint && selectedStopIdx < stops.length - 1
										? handleStopMidpointChange
										: undefined
								}
							/>
						</div>
					)}
				</Popover.Content>
			</Popover.Root>
		</div>
	);
});

// --- Stop Color Editor ---

const StopColorEditor = memo(function StopColorEditor({
	stop,
	onStopColorChange,
	onMidpointChange,
}: {
	stop: ColorStop;
	onStopColorChange: (color: Color) => void;
	/** Omit to hide the midpoint slider (e.g. last stop, or midpoint disabled). */
	onMidpointChange?: (midpoint: number) => void;
}) {
	const t = useTranslation();
	const handleColorChange = useEventCallback((color: Color) => {
		onStopColorChange(color);
	});

	return (
		<div className="flex flex-col gap-3">
			<ColorPickerFull
				color={stop.color}
				onColorChange={handleColorChange}
				saturationHeight="h-32"
			/>
			{onMidpointChange && (
				<div className="flex flex-col gap-1 text-xs text-muted-foreground">
					<div className="flex items-center justify-between">
						<span>{t("toolbar.gradientMidpoint")}</span>
						<FakeInput
							$size="xs"
							type="number"
							value={String(Math.round(stop.midpoint * 100))}
							step={1}
							min={1}
							max={99}
							onChange={(v) => onMidpointChange(v ? Number(v) / 100 : 0.5)}
							className="w-14 text-right tabular-nums"
						/>
					</div>
					<Slider
						value={stop.midpoint * 100}
						min={1}
						max={99}
						step={1}
						onValueChange={(v) => onMidpointChange(v / 100)}
					/>
				</div>
			)}
		</div>
	);
});

// --- Free Gradient Editor ---

const FreeEditor = memo(function FreeEditor() {
	const t = useTranslation();
	const paplico = usePaplicoMaybe();

	const handleClick = useEventCallback(() => {
		paplico?.tools.setCurrentTool("gradient");
	});

	return (
		<button
			type="button"
			className="flex w-full flex-col items-center gap-2 rounded border border-dashed border-border p-4 transition-colors hover:bg-muted"
			onClick={handleClick}
		>
			<Grid3x3 size={24} className="text-muted-foreground" />
			<span className="text-xs text-muted-foreground">
				{t("toolbar.editWithGradientTool")}
			</span>
		</button>
	);
});

// --- Mesh Gradient Editor ---

const MeshEditor = memo(function MeshEditor() {
	const t = useTranslation();
	const paplico = usePaplicoMaybe();

	const handleClick = useEventCallback(() => {
		paplico?.tools.setCurrentTool("gradient");
	});

	return (
		<button
			type="button"
			className="flex w-full flex-col items-center gap-2 rounded border border-dashed border-border p-4 transition-colors hover:bg-muted"
			onClick={handleClick}
		>
			<Hexagon size={24} className="text-muted-foreground" />
			<span className="text-xs text-muted-foreground">
				{t("toolbar.editWithGradientTool")}
			</span>
		</button>
	);
});

// --- Pattern Editor ---

export const PatternEditor = memo(function PatternEditor({
	fill,
	onFillChange,
}: {
	fill: PatternFill | null;
	onFillChange: (fill: FillColor | null) => void;
}) {
	const paplico = usePaplicoMaybe();
	// Bail out when there's no Paplico instance (e.g. Storybook standalone)
	// so hook usage stays consistent and the picker still has a visual.
	if (!paplico) {
		return <PatternEditorStandalone />;
	}
	return (
		<PatternEditorInner
			fill={fill}
			onFillChange={onFillChange}
			paplico={paplico}
		/>
	);
});

function PatternEditorStandalone() {
	const t = useTranslation();
	return (
		<div className="rounded border border-dashed border-border p-2 text-center text-xs text-muted-foreground">
			{t("toolbar.patternEmpty")}
		</div>
	);
}

function PatternEditorInner({
	fill,
	onFillChange,
	paplico,
}: {
	fill: PatternFill | null;
	onFillChange: (fill: FillColor | null) => void;
	paplico: NonNullable<ReturnType<typeof usePaplicoMaybe>>;
}) {
	const t = useTranslation();
	const store = paplico.uiState;
	const docSnap = useSnapshot(store);

	const { list: patternDefs, nextName: nextPatternDefName } = usePatternDefs();

	const selectedDef = fill?.defId
		? (docSnap.document.defs?.[fill.defId] as DefEntry | undefined)
		: undefined;

	const handlePickDef = useEventCallback((defId: string) => {
		if (!fill) {
			onFillChange({ ...createDefaultPatternFill(), defId });
			return;
		}
		onFillChange({ ...fill, defId });
	});

	const handleCreateFromSelection = useEventCallback(() => {
		const newDefId = paplico.commands.createPatternDefFromSelection(
			nextPatternDefName(),
		);
		if (!newDefId) return;
		// Select the freshly-created def so the editor reflects it immediately.
		if (fill) {
			onFillChange({ ...fill, defId: newDefId });
		} else {
			onFillChange({ ...createDefaultPatternFill(), defId: newDefId });
		}
	});

	const handleRename = useEventCallback((next: string | undefined) => {
		if (!fill?.defId) return;
		const trimmed = next?.trim();
		if (trimmed == null || trimmed.length === 0) return;
		if (selectedDef?.name === trimmed) return;
		paplico.commands.updateDefMeta(fill.defId, { name: trimmed });
	});

	const handleEdit = useEventCallback(() => {
		if (!fill?.defId) return;
		paplico.patternEdit.enter(fill.defId);
	});

	const handleScaleChange = useEventCallback((value: number) => {
		if (!fill) return;
		onFillChange({ ...fill, scaleX: value, scaleY: value });
	});
	const handleRotationChange = useEventCallback((degrees: number) => {
		if (!fill) return;
		onFillChange({ ...fill, rotation: (degrees * Math.PI) / 180 });
	});
	const handleOffsetXChange = useEventCallback((value: number) => {
		if (!fill) return;
		onFillChange({ ...fill, offsetX: value });
	});
	const handleOffsetYChange = useEventCallback((value: number) => {
		if (!fill) return;
		onFillChange({ ...fill, offsetY: value });
	});

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">
					{t("toolbar.patternLibrary")}
				</span>
				<Tooltip content={t("toolbar.patternCreateFromSelection")}>
					<IconButton
						$size="sm"
						$variant="ghost"
						onClick={handleCreateFromSelection}
						aria-label={t("toolbar.patternCreateFromSelection")}
					>
						<PlusSquare size={14} />
					</IconButton>
				</Tooltip>
			</div>
			<div className="grid max-h-32 grid-cols-4 gap-1 overflow-y-auto rounded border border-border p-1">
				<button
					type="button"
					onClick={() => onFillChange(null)}
					className={`flex aspect-square items-center justify-center rounded border text-[10px] ${
						!fill
							? "border-primary text-foreground ring-1 ring-primary"
							: "border-border text-muted-foreground hover:border-primary/50"
					}`}
					title={t("toolbar.gradientNone")}
				>
					{t("toolbar.gradientNone")}
				</button>
				{patternDefs.length === 0 && (
					<div className="col-span-4 flex flex-col items-center gap-1 p-2 text-center text-xs text-muted-foreground">
						<LayoutGrid size={20} />
						{t("toolbar.patternEmpty")}
					</div>
				)}
				{patternDefs.map((entry) => {
					const isSelected = fill?.defId === entry.id;
					return (
						<button
							key={entry.id}
							type="button"
							onClick={() => handlePickDef(entry.id)}
							className={`flex aspect-square items-center justify-center rounded border bg-muted text-[10px] text-muted-foreground ${
								isSelected
									? "border-primary ring-1 ring-primary"
									: "border-border hover:border-primary/50"
							}`}
							title={entry.name ?? entry.id}
						>
							{(entry.name ?? entry.id).slice(0, 6)}
						</button>
					);
				})}
			</div>
			{fill && selectedDef && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<FakeInput
							$size="xs"
							type="text"
							value={selectedDef.name ?? selectedDef.id}
							onChange={handleRename}
							className="min-w-0 flex-1 truncate"
						/>
						<Tooltip content={t("toolbar.patternEdit")}>
							<IconButton
								$size="sm"
								$variant="ghost"
								onClick={handleEdit}
								aria-label={t("toolbar.patternEdit")}
							>
								<Edit3 size={14} />
							</IconButton>
						</Tooltip>
					</div>
					<div className="flex flex-col gap-1 text-xs text-muted-foreground">
						<div className="flex items-center justify-between">
							<span>{t("toolbar.patternScale")}</span>
							<FakeInput
								$size="xs"
								type="number"
								value={String(fill.scaleX)}
								step={0.01}
								min={0.01}
								max={4}
								onChange={(v) => handleScaleChange(v ? Number(v) : 1)}
								className="w-14 text-right tabular-nums"
							/>
						</div>
						<Slider
							value={fill.scaleX}
							min={0.01}
							max={4}
							step={0.01}
							onValueChange={handleScaleChange}
						/>
					</div>
					<div className="flex flex-col gap-1 text-xs text-muted-foreground">
						<div className="flex items-center justify-between">
							<span>{t("toolbar.patternRotation")}</span>
							<FakeInput
								$size="xs"
								type="number"
								value={String(Math.round((fill.rotation * 180) / Math.PI))}
								step={1}
								min={-180}
								max={180}
								onChange={(v) => handleRotationChange(v ? Number(v) : 0)}
								className="w-14 text-right tabular-nums"
							/>
						</div>
						<Slider
							value={(fill.rotation * 180) / Math.PI}
							min={-180}
							max={180}
							step={1}
							onValueChange={handleRotationChange}
						/>
					</div>
					<div className="flex flex-col gap-1 text-xs text-muted-foreground">
						<div className="flex items-center justify-between">
							<span>{t("toolbar.patternOffsetX")}</span>
							<FakeInput
								$size="xs"
								type="number"
								value={String(fill.offsetX)}
								step={1}
								onChange={(v) => handleOffsetXChange(v ? Number(v) : 0)}
								className="w-14 text-right tabular-nums"
							/>
						</div>
						<Slider
							value={fill.offsetX}
							min={-500}
							max={500}
							step={1}
							onValueChange={handleOffsetXChange}
						/>
					</div>
					<div className="flex flex-col gap-1 text-xs text-muted-foreground">
						<div className="flex items-center justify-between">
							<span>{t("toolbar.patternOffsetY")}</span>
							<FakeInput
								$size="xs"
								type="number"
								value={String(fill.offsetY)}
								step={1}
								onChange={(v) => handleOffsetYChange(v ? Number(v) : 0)}
								className="w-14 text-right tabular-nums"
							/>
						</div>
						<Slider
							value={fill.offsetY}
							min={-500}
							max={500}
							step={1}
							onValueChange={handleOffsetYChange}
						/>
					</div>
				</div>
			)}
			{fill && !fill.defId && (
				<div className="rounded border border-dashed border-border p-2 text-center text-xs text-muted-foreground">
					{t("toolbar.patternSelectHint")}
				</div>
			)}
		</div>
	);
}
