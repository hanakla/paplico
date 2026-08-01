/**
 * Stroke rendering engine barrel — internal to renderer/canvas/pipeline/.
 * Re-exports the public surface of the per-brush StrokeEngine wrappers and
 * the registry / picker that CanvasLayer consumes.
 */

export {
	createGeometricStrokeEngine,
	GeometricStrokeEngine,
	type GeometricStrokeRenderFn,
} from "./GeometricStrokeEngine";
export {
	createRibbonStrokeEngine,
	RibbonStrokeEngine,
} from "./RibbonStrokeEngine";
export { resolveStrokeStyle } from "./resolveStrokeStyle";
export {
	createStampStrokeEngine,
	StampStrokeEngine,
} from "./StampStrokeEngine";
export type {
	EnginePipeline,
	EnginePipelineContext,
	ResolvedStrokeColor,
	ResolvedStrokeStyle,
	ResolvedTextureBindings,
	SelfOverlap,
	SharedBindGroupLayouts,
	StrokeEngine,
} from "./StrokeEngine";
export {
	StrokeEngineRegistry,
	type StrokeEngineRegistryEngines,
} from "./StrokeEnginePicker";
