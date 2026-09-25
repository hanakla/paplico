import type { TextLayout } from "../schema";

type WritingMode = TextLayout["writingMode"];
type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
type CursorDirection = "left" | "right" | "up" | "down";

const ARROW_REMAP: Record<WritingMode, Record<ArrowKey, CursorDirection>> = {
	"horizontal-tb": {
		ArrowUp: "up",
		ArrowDown: "down",
		ArrowLeft: "left",
		ArrowRight: "right",
	},
	"vertical-rl": {
		ArrowUp: "left",
		ArrowDown: "right",
		ArrowLeft: "down",
		ArrowRight: "up",
	},
	"vertical-lr": {
		ArrowUp: "left",
		ArrowDown: "right",
		ArrowLeft: "up",
		ArrowRight: "down",
	},
};

/**
 * Remap a physical arrow key to a logical cursor direction based on writing mode.
 *
 * In vertical text, characters flow top-to-bottom within a column.
 * Up/Down become inline (prev/next char), Left/Right become cross-line.
 */
export function remapArrowToCursor(
	key: ArrowKey,
	wm: WritingMode,
): CursorDirection {
	return ARROW_REMAP[wm][key];
}

/**
 * Whether the arrow key corresponds to the inline direction (along the text flow).
 * horizontal: Left/Right are inline. vertical: Up/Down are inline.
 */
export function isInlineDirection(key: ArrowKey, wm: WritingMode): boolean {
	if (wm === "horizontal-tb") {
		return key === "ArrowLeft" || key === "ArrowRight";
	}
	return key === "ArrowUp" || key === "ArrowDown";
}

/**
 * Whether the arrow key is the positive inline direction (advancing forward in text flow).
 * horizontal: Right. vertical: Down.
 */
export function isPositiveInlineDirection(
	key: ArrowKey,
	wm: WritingMode,
): boolean {
	if (wm === "horizontal-tb") return key === "ArrowRight";
	return key === "ArrowDown";
}

/**
 * Whether the arrow key is the positive cross direction (next line/column).
 * horizontal: Down (next line below).
 * vertical-rl: Left (next column goes leftward).
 * vertical-lr: Right (next column goes rightward).
 */
export function isPositiveCrossDirection(
	key: ArrowKey,
	wm: WritingMode,
): boolean {
	if (wm === "horizontal-tb") return key === "ArrowDown";
	if (wm === "vertical-rl") return key === "ArrowLeft";
	return key === "ArrowRight";
}
