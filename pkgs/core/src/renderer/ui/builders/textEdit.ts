import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { TextEditUIData } from "../types";

/**
 * Text edit overlay: selection rects, blinking cursor bar and IME
 * composition underline. Rotated variants are fat-line fills built from the
 * world anchor + rotation directly; the bar thickness (2px screen) is a size,
 * not an AA-compensated stroke width.
 */
export function buildTextEditOverlay(
	data: TextEditUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];

	// Selection rectangles (rendered behind cursor)
	const selectionColor = theme.colors.textSelection;
	for (const rect of data.selectionRects) {
		if (rect.rotation !== 0) {
			const cosR = Math.cos(rect.rotation);
			const sinR = Math.sin(rect.rotation);
			const hh = rect.height / 2;
			// rect.x/y is the world-transformed anchor (bottom-left corner).
			// Build the fat line from anchor + rotation directly.
			const x1 = rect.x - hh * sinR;
			const y1 = rect.y + hh * cosR;
			prims.push({
				kind: "line",
				x1,
				y1,
				x2: x1 + rect.width * cosR,
				y2: y1 + rect.width * sinR,
				fill: { color: selectionColor, width: rect.height },
			});
		} else {
			prims.push({
				kind: "rect",
				cx: rect.x + rect.width / 2,
				cy: rect.y + rect.height / 2,
				width: rect.width,
				height: rect.height,
				fill: { color: selectionColor },
			});
		}
	}

	// Cursor bar (2px screen thickness)
	if (data.cursor?.visible) {
		const c = data.cursor;
		const cursorColor = theme.colors.selectionBounds;
		const isVertical =
			c.writingMode === "vertical-rl" || c.writingMode === "vertical-lr";

		if (c.rotation !== 0) {
			const cosR = Math.cos(c.rotation);
			const sinR = Math.sin(c.rotation);
			if (isVertical) {
				// Horizontal bar: anchor = left end, extends rightward
				prims.push({
					kind: "line",
					x1: c.x,
					y1: c.y,
					x2: c.x + c.height * cosR,
					y2: c.y + c.height * sinR,
					screenOffset: { x: -sinR, y: cosR },
					fill: { color: cursorColor, width: { screen: 2 } },
				});
			} else {
				// Vertical bar: anchor = bottom, extends upward
				prims.push({
					kind: "line",
					x1: c.x,
					y1: c.y,
					x2: c.x - c.height * sinR,
					y2: c.y + c.height * cosR,
					screenOffset: { x: cosR, y: sinR },
					fill: { color: cursorColor, width: { screen: 2 } },
				});
			}
		} else if (isVertical) {
			prims.push({
				kind: "rect",
				cx: c.x + c.height / 2,
				cy: c.y,
				screenOffset: { x: 0, y: 1 },
				width: c.height,
				height: { screen: 2 },
				fill: { color: cursorColor },
			});
		} else {
			prims.push({
				kind: "rect",
				cx: c.x,
				cy: c.y + c.height / 2,
				screenOffset: { x: 1, y: 0 },
				width: { screen: 2 },
				height: c.height,
				fill: { color: cursorColor },
			});
		}
	}

	// IME composition underline (2px screen thickness)
	if (data.compositionUnderline) {
		const u = data.compositionUnderline;
		const underlineColor = theme.colors.textCompositionUnderline;

		if (u.rotation !== 0) {
			const cosR = Math.cos(u.rotation);
			const sinR = Math.sin(u.rotation);
			prims.push({
				kind: "line",
				x1: u.x,
				y1: u.y,
				x2: u.x + u.width * cosR,
				y2: u.y + u.width * sinR,
				fill: { color: underlineColor, width: { screen: 2 } },
			});
		} else {
			prims.push({
				kind: "rect",
				cx: u.x + u.width / 2,
				cy: u.y,
				screenOffset: { x: 0, y: 1 },
				width: u.width,
				height: { screen: 2 },
				fill: { color: underlineColor },
			});
		}
	}

	return prims;
}
