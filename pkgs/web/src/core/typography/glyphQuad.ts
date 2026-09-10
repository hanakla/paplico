import type { LayoutedChar } from "./TextLayoutEngine";

/** Ascent portion of the em box above the baseline (descent = 1 - this) */
const ASCENT_RATIO = 0.8;

export interface TextGlyphQuadPoint {
	x: number;
	y: number;
}

/**
 * Rotated bounding quad of a laid-out glyph. The single source of truth for
 * the touch-type pivot: layout (glyph rendering), selection rects, hit
 * testing and the tool overlay all derive their geometry from here so the
 * handles never drift from the drawn glyph.
 */
export interface TextGlyphQuad {
	charIndex: number;
	/** Rotation pivot: baseline advance midpoint (line) / glyph center (onPath) */
	pivot: TextGlyphQuadPoint;
	/** Advance width of the glyph (sizeScale applied) */
	width: number;
	/** Em-box height (fontSize, sizeScale applied) */
	height: number;
	/** Visual rotation in radians (Y-up, counterclockwise) */
	rotation: number;
	/** Unrotated extents relative to the pivot (for hit testing) */
	localBounds: { minX: number; minY: number; maxX: number; maxY: number };
	/** Corners in drawing order, rotated around the pivot */
	corners: [
		TextGlyphQuadPoint,
		TextGlyphQuadPoint,
		TextGlyphQuadPoint,
		TextGlyphQuadPoint,
	];
}

/** Touch-type rotation pivot: midpoint of the advance on the baseline */
export function getGlyphPivot(
	x: number,
	y: number,
	advanceWidth: number,
): TextGlyphQuadPoint {
	return { x: x + advanceWidth / 2, y };
}

/**
 * Translate a glyph anchor so that rotating the glyph about its own origin by
 * `rotRad` at the returned anchor equals rotating it about `pivot` at the
 * original anchor. Composes with an already-rotated glyph (vertical
 * punctuation, on-path tangent): pass the combined rotation and the
 * pre-rotation anchor.
 */
export function rotateAnchorAroundPivot(
	anchorX: number,
	anchorY: number,
	pivotX: number,
	pivotY: number,
	rotRad: number,
): TextGlyphQuadPoint {
	const cos = Math.cos(rotRad);
	const sin = Math.sin(rotRad);
	const dx = anchorX - pivotX;
	const dy = anchorY - pivotY;
	return {
		x: pivotX + dx * cos - dy * sin,
		y: pivotY + dx * sin + dy * cos,
	};
}

/**
 * Build the rotated quad for a laid-out glyph. Line layouts anchor chars at
 * baseline-left (char.x/y is the unrotated pen position); on-path layouts
 * anchor at the glyph center on the spine point.
 */
export function getGlyphQuad(
	char: LayoutedChar,
	anchor: "baselineLeft" | "center",
): TextGlyphQuad {
	const w = char.advanceWidth;
	const h = char.fontSize;
	const rotation = char.rotation;

	let pivot: TextGlyphQuadPoint;
	let localBounds: TextGlyphQuad["localBounds"];
	if (anchor === "baselineLeft") {
		pivot = getGlyphPivot(char.x, char.y, w);
		localBounds = {
			minX: -w / 2,
			maxX: w / 2,
			minY: -h * (1 - ASCENT_RATIO),
			maxY: h * ASCENT_RATIO,
		};
	} else {
		pivot = { x: char.x, y: char.y };
		localBounds = { minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 };
	}

	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	const corner = (lx: number, ly: number): TextGlyphQuadPoint => ({
		x: pivot.x + lx * cos - ly * sin,
		y: pivot.y + lx * sin + ly * cos,
	});

	return {
		charIndex: char.charIndex,
		pivot,
		width: w,
		height: h,
		rotation,
		localBounds,
		corners: [
			corner(localBounds.minX, localBounds.minY),
			corner(localBounds.maxX, localBounds.minY),
			corner(localBounds.maxX, localBounds.maxY),
			corner(localBounds.minX, localBounds.maxY),
		],
	};
}

/** Point-in-quad test in the quad's unrotated frame, padded by tolerance */
export function hitTestGlyphQuad(
	quad: TextGlyphQuad,
	px: number,
	py: number,
	tolerance = 0,
): boolean {
	const cos = Math.cos(-quad.rotation);
	const sin = Math.sin(-quad.rotation);
	const dx = px - quad.pivot.x;
	const dy = py - quad.pivot.y;
	const lx = dx * cos - dy * sin;
	const ly = dx * sin + dy * cos;
	const { minX, minY, maxX, maxY } = quad.localBounds;
	return (
		lx >= minX - tolerance &&
		lx <= maxX + tolerance &&
		ly >= minY - tolerance &&
		ly <= maxY + tolerance
	);
}
