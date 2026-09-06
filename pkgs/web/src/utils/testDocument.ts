/**
 * Showcase Test Document
 *
 * Paplico の全機能を網羅するデモドキュメント。
 *
 * ## Artboards
 *   - "Main"            — Shapes + Strokes + Gradients
 *   - "Text"            — Horizontal / Vertical text
 *   - "Filters"         — Blur / FrostGlass / DropShadow / Zigzag
 *   - "BlendModes"      — All 12 blend modes
 *   - "Transforms"      — Rotation / Scale / Combined
 *   - "Opacity"         — Element + Layer opacity
 *   - "Groups"          — Group children + Clipping mask + CompoundPath clip
 *   - "CompoundPaths"   — Boolean operations
 *   - "StrokeGradients" — Within / Along / Across
 *   - "MultiFilters"    — Stacked filter combos
 *   - "SubFilters"      — Per-appearance sub-filter rendering
 *
 * ## Layers (bottom → top)
 *   1. Shapes          — Rectangle, Rounded rect, Circle, Star, Freehand closed bezier
 *   2. Strokes         — Solid line, Pencil, Airbrush, Soft brush
 *   3. Gradients       — Linear, Radial, Free gradient fills
 *   4. Text            — Horizontal (left/center/right), Vertical (left/center/right)
 *   5. Filters         — Blur rect, FrostGlass text, DropShadow star, Zigzag circle
 *   6. Blend Bases     — Base colored rects for blend mode comparison
 *   7. Blend Overlays  — Yellow circles with different blend modes
 *   8. Transforms      — Rotation, Scale, Combined transforms
 *   9. Opacity         — Element opacity variations
 *  10. Opacity Half    — Layer opacity = 0.5
 *  11. Groups          — Group elements (children in doc.objects)
 *  12. CompoundPaths   — Boolean operation results
 *  13. StrokeGradients — Stroke gradient paths (within/along/across)
 *  14. MultiFilters    — Multiple stacked filters
 */
import { nanoid } from "nanoid";
import {
	createDefaultBrushSettings,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../core/document/factory";
import {
	type Color,
	type CubicBezierSegment,
	type Document,
	type FilterEntry,
	generateUid,
	type Layer,
	type Path,
	type StrokeAppearance,
	type StrokeColor,
	type TextElement,
} from "../core/schema";

export function createTestDocument(): Document {
	const doc = createDefaultDocument(`test-${nanoid(8)}`);

	const addElement = (layer: Layer, el: Path | TextElement) => {
		doc.objects[el.id] = el;
		layer.elementIds.push(el.id);
	};

	// =========================================================================
	// Layer 6 — Stress Test (1000 brush strokes, narrow distribution)
	// =========================================================================
	const stressLayer = createDefaultLayer("layer-stress", "Stress 6000");
	const brushTypes = ["solid", "pencil", "airbrush"] as const;
	const stressColors = [charcoal, coral, indigo, rose, teal];
	const STRESS_COUNT = 12000;
	const SPREAD = 400; // 狭い範囲に密集

	for (let i = 0; i < STRESS_COUNT; i++) {
		// 決定論的な疑似ランダム (nanoid は毎回変わるが座標は再現可能)
		const seed = i * 7919;
		const sx = ((seed * 13) % SPREAD) - SPREAD / 2;
		const sy = ((seed * 17) % SPREAD) - SPREAD / 2;
		const dx = ((seed * 23) % 2000) - 1000;
		const dy = ((seed * 29) % 2000) - 1000;
		const brush = brushTypes[i % brushTypes.length];
		const solidColor = stressColors[i % stressColors.length];
		const size = 4 + (i % 12);

		// 5個に1個をグラデーションパスにする
		const useGradient = i % 5 === 0;
		const modes = ["along", "within", "across"] as const;
		const strokeColor: StrokeColor = useGradient
			? {
					type: "stroke-gradient",
					mode: modes[i % 3],
					gradient: {
						type: "linear",
						x1: 0,
						y1: 0,
						x2: 1,
						y2: 0,
						stops: [
							{ offset: 0, color: stressColors[i % 5], midpoint: 0.5 },
							{ offset: 1, color: stressColors[(i + 2) % 5], midpoint: 0.5 },
						],
					},
				}
			: { type: "solid", color: solidColor };

		const stressFilters: Path["filters"] =
			i % 10 === 0
				? [
						{
							uid: generateUid("filter"),
							opacity: 1,
							enabled: true,
							blendMode: "normal",
							processor: "frost-glass",
							applyToBackdrop: true,
							paramData: {
								version: "1",
								params: {
									radius: 8,
									saturation: 1,
									tint: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
									tintOpacity: 0.2,
								},
							},
						},
					]
				: undefined;

		addElement(
			stressLayer,
			createBrushStroke(
				[
					{ x: sx, y: sy, pressure: 0.3 },
					{ x: sx + dx * 0.33, y: sy + dy * 0.5, pressure: 0.6 },
					{ x: sx + dx * 0.66, y: sy + dy * 0.3, pressure: 0.8 },
					{ x: sx + dx, y: sy + dy, pressure: 0.4 },
				],
				size,
				strokeColor,
				brush,
				stressFilters,
			),
		);
	}

	// =========================================================================
	// Assemble
	// =========================================================================
	doc.layers = [stressLayer];
	return doc;
}

// =============================================================================
// Colors
// =============================================================================

const charcoal: Color = {
	type: "rgb",
	r: 0.2,
	g: 0.2,
	b: 0.22,
	a: 1,
};

const coral: Color = {
	type: "rgb",
	r: 0.96,
	g: 0.4,
	b: 0.35,
	a: 1,
};

const indigo: Color = {
	type: "rgb",
	r: 0.3,
	g: 0.3,
	b: 0.85,
	a: 1,
};

const rose: Color = {
	type: "rgb",
	r: 0.85,
	g: 0.25,
	b: 0.5,
	a: 1,
};

const teal: Color = {
	type: "rgb",
	r: 0.1,
	g: 0.7,
	b: 0.65,
	a: 1,
};

// =============================================================================
// Segment Helpers
// =============================================================================

function createBrushStroke(
	points: { x: number; y: number; pressure: number }[],
	size: number,
	color: StrokeColor,
	brushType: "solid" | "pencil" | "airbrush",
	filters?: Path["filters"],
): Path {
	const segments: CubicBezierSegment[] = [];

	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i];
		const p1 = points[i + 1];
		const prev = points[Math.max(0, i - 1)];
		const next = points[Math.min(points.length - 1, i + 2)];

		// cp1 relative to start anchor (p0), cp2 relative to end (p1)
		segments.push({
			start: i === 0 ? { x: p0.x, y: p0.y, pressure: p0.pressure } : undefined,
			cp1: {
				x: (p1.x - prev.x) / 6,
				y: (p1.y - prev.y) / 6,
				pressure: p0.pressure,
			},
			cp2: {
				x: -(next.x - p0.x) / 6,
				y: -(next.y - p0.y) / 6,
				pressure: p1.pressure,
			},
			end: { x: p1.x, y: p1.y, pressure: p1.pressure },
			startPressure: p0.pressure,
			endPressure: p1.pressure,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		});
	}

	const allFilters: FilterEntry[] = [
		{
			uid: nanoid(),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: color,
					brushSettings: {
						...createDefaultBrushSettings(),
						textureFileUid: `builtin-brush-${brushType}`,
						size,
					},
					width: size,
				},
			},
		} as StrokeAppearance,
	];

	if (filters) {
		allFilters.push(...filters);
	}

	return {
		type: "path",
		id: nanoid(),
		opacity: 1,
		blendMode: "normal",
		segments,
		filters: allFilters,
		transform: createDefaultTransform(),
	};
}
