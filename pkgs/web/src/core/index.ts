// biome-ignore-all assist/source/organizeImports: hand managed
if (process.env.NODE_ENV === "development") {
	import("./dev-hmr");
}

export { Paplico } from "./Paplico";

// Errors
export type { PaplicoErrorCode } from "./errors";
export { isPaplicoError, PaplicoError } from "./errors";

// Collaboration
export { createCollaboration } from "./collaboration/createCollaboration";
export { TextToolController } from "./tools/TextToolController";

// Tools
export type { ShapeType } from "./tools/toolSettings";

// Brush types
export type { BuiltinBrushId, StampRotation } from "./schema";
export { BRUSH_PRESETS } from "./brush/presets";
export { BUILTIN_BRUSH_IDS } from "./schema";
export {
	createDefaultBrushSettings,
	createStrokeBrushSettings,
} from "./document/factory";

// Fonts
export type { FontMetadata, FontScript } from "./typography/fonts";
export { FONT_SCRIPT_ORDER, getFontManager } from "./typography/fonts";

// Utilities
export { worldToScreen } from "./utils/geometry/geometry";
export { ColorAdjustStrategies } from "./utils/color";
export { AdjustColorSession } from "./PaplicoCommands";
