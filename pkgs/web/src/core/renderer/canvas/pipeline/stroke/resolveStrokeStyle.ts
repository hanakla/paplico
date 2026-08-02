/**
 * resolveStrokeStyle — pure helper that assembles a ResolvedStrokeStyle from a
 * Path + its (already-pre-filter-applied) segments + the resolved alpha and
 * transform index.
 *
 * Currently keeps `textures` empty and `color` synthesised from the path's
 * StrokeColor; the actual GPU resource resolution still lives inside the
 * StrokeBatchContext (texture manager) and ElementRenderer (gradient
 * renderer). A later refactor will let engines read from `textures` /
 * `color` directly.
 */

import { normalizeBrushSettings } from "../../../../brush/normalize";
import { createDefaultBrushSettings } from "../../../../document/factory";
import {
	type BrushSettings,
	type CubicBezierSegment,
	colorToRawRGBA,
	type Path,
	type StrokeAppearance,
	type StrokeColor,
} from "../../../../schema";
import type { ResolvedStrokeColor, ResolvedStrokeStyle } from "./StrokeEngine";

export interface ResolveStrokeStyleInput {
	path: Path;
	segments: CubicBezierSegment[];
	alphaMultiplier: number;
	transformIndex: number;
	/**
	 * Optional pre-extracted appearance. When provided, brushSettings and
	 * strokeColor are taken from it instead of being re-derived from
	 * `path.filters`. Used by the batch loop which already inspected the
	 * appearance once.
	 */
	strokeAppearance?: StrokeAppearance;
}

/**
 * Build a ResolvedStrokeStyle ready for engine dispatch.
 *
 * Returns `null` when the path has no stroke appearance (engines have nothing
 * to render).
 */
export function resolveStrokeStyle(
	input: ResolveStrokeStyleInput,
): ResolvedStrokeStyle | null {
	const { path, segments, alphaMultiplier, transformIndex } = input;

	const strokeApp =
		input.strokeAppearance ??
		(path.filters?.find((f) => f.processor === "stroke") as
			| StrokeAppearance
			| undefined) ??
		null;
	const strokeColor = strokeApp?.paramData.params.strokeColor;
	if (!strokeApp || !strokeColor) return null;

	const rawBrush = strokeApp.paramData.params.brushSettings;
	const brush: BrushSettings = rawBrush
		? normalizeBrushSettings(rawBrush)
		: createDefaultBrushSettings();

	return {
		segments,
		strokeWidths: path.strokeWidths,
		pathStart: path.pathStart,
		pathEnd: path.pathEnd,
		brush,
		textures: { primary: null },
		color: resolveStrokeColorScalar(strokeColor),
		selfOverlap: "over",
		alphaMultiplier,
		transformIndex,
		legacyPath: path,
		legacyStrokeColor: strokeColor,
	};
}

/**
 * Scalar fallback used while engines still hand the resolved style to
 * StrokeBatchContext, which reads gradient / pattern data straight off the
 * Path. Non-solid colors collapse to opaque black here; the actual gradient
 * sampling happens downstream.
 */
function resolveStrokeColorScalar(
	strokeColor: StrokeColor,
): ResolvedStrokeColor {
	if (strokeColor.type === "solid") {
		const c = colorToRawRGBA(strokeColor.color);
		return { kind: "solid", r: c.r, g: c.g, b: c.b, a: c.a };
	}
	return {
		kind: "solid",
		r: 0,
		g: 0,
		b: 0,
		a: 1,
	};
}
