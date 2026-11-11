import { createStrokeBrushSettings } from "../document/factory";
import {
	createDefaultContentAppearance,
	type FillAppearance,
	type FillParams,
	type Filter,
	generateUid,
	type StrokeAppearance,
	type StrokeParams,
	type TextStyle,
} from "../schema";

/** Stands in a text's paint stack for the fill the glyphs carry themselves. */
export const INTRINSIC_FILL = Symbol("intrinsic-fill");

/**
 * Ordered paint list resolved from a text's appearance stack.
 * `INTRINSIC_FILL` stands for the glyphs' own fill (per-run fill, else the
 * default style fill) and sits at the "content" entry's stack position;
 * elements with no content entry paint it below the stack. Fill/stroke
 * appearances overpaint in stack order and disabled entries are skipped. A
 * default-style stroke applies only while no stroke appearance exists.
 */
export function resolveTextPaintStack(opts: {
	elementFilters: Filter[];
	defaultStroke: StrokeParams["strokeColor"] | null;
	defaultBrushWidth: number;
}): (Filter | typeof INTRINSIC_FILL)[] {
	const { elementFilters, defaultStroke, defaultBrushWidth } = opts;

	const stack: (Filter | typeof INTRINSIC_FILL)[] = [];
	if (!elementFilters.some((f) => f.processor === "content")) {
		stack.push(INTRINSIC_FILL);
	}

	let hasStrokeApp = false;
	for (const app of elementFilters) {
		if (app.enabled === false) continue;
		if (app.processor === "content") {
			stack.push(INTRINSIC_FILL);
		} else if (app.processor === "fill") {
			stack.push({ ...(app as FillAppearance) });
		} else if (app.processor === "stroke") {
			hasStrokeApp = true;
			const params = (app as StrokeAppearance).paramData.params;
			stack.push({
				...(app as StrokeAppearance),
				paramData: {
					version: "1",
					params: {
						strokeColor: params.strokeColor,
						brushSettings:
							params.brushSettings ??
							createStrokeBrushSettings(defaultBrushWidth),
					},
				},
			} as StrokeAppearance);
		}
	}

	// Default-style stroke paints on top only while no stroke appearance
	// overrides it.
	if (!hasStrokeApp && defaultStroke != null) {
		stack.push({
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: defaultStroke,
					brushSettings: createStrokeBrushSettings(defaultBrushWidth),
				},
			},
		} as StrokeAppearance);
	}

	return stack;
}

/**
 * The paint of a text turned into a group of glyph paths. The group carries
 * the text's fills and strokes, which paint its glyphs as one shape. While
 * every glyph shares one fill the group carries that fill too; glyphs filled
 * differently keep their own fill and paint at the group's content entry.
 */
export function resolveOutlinedTextPaint(opts: {
	elementFilters: Filter[];
	defaultStyle: TextStyle;
	/** Per glyph, the fill of the run it belongs to. */
	runFills: readonly (FillParams["fill"] | null | undefined)[];
}): { groupFilters: Filter[]; glyphFilters: Filter[][] } {
	const { elementFilters, defaultStyle, runFills } = opts;
	const glyphFills = runFills.map((fill) => fill ?? defaultStyle.fill ?? null);
	const sharedFill = glyphFills[0] ?? null;
	const isUniform = new Set(glyphFills.map((f) => JSON.stringify(f))).size <= 1;

	const groupFilters = resolveTextPaintStack({
		elementFilters,
		defaultStroke: defaultStyle.stroke ?? null,
		defaultBrushWidth: defaultTextStrokeWidth(defaultStyle),
	}).flatMap((entry) => {
		if (entry !== INTRINSIC_FILL) {
			return [{ ...entry, uid: generateUid("app") }];
		}
		return isUniform && sharedFill
			? [createDefaultContentAppearance(), outlinedFill(sharedFill)]
			: [createDefaultContentAppearance()];
	});

	return {
		groupFilters,
		glyphFilters: glyphFills.map((fill) =>
			isUniform || !fill ? [] : [outlinedFill(fill)],
		),
	};
}

/** Width of a text's default-style stroke when the style names none. */
export function defaultTextStrokeWidth(style: TextStyle): number {
	return style.strokeWidth ?? Math.max(1, style.fontSize * 0.03);
}

export function fillAppearanceOf(fill: FillParams["fill"]): FillAppearance {
	return {
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { fill } },
	} as FillAppearance;
}

/** A fill appearance stored on an outlined text's group or glyph path. */
function outlinedFill(fill: FillParams["fill"]): FillAppearance {
	return { ...fillAppearanceOf(fill), uid: generateUid("app") };
}
