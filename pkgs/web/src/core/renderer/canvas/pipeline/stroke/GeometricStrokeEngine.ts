/**
 * GeometricStrokeEngine — owns BrushType `stroke` (geometric pen).
 *
 * Defers rendering to ElementRenderer.renderPath, which already routes
 * geometric brushes through renderGeometricStroke (strokeTessellator + GPU
 * stroke pipeline). The engine has no addToBatch because geometric strokes
 * never participate in the stamp/ribbon batch flow.
 */

import type { BrushType, Path } from "../../../../schema";
import type { PipelineType } from "../../CanvasLayerTypes";
import type {
	EnginePipeline,
	EnginePipelineContext,
	ResolvedStrokeStyle,
	StrokeEngine,
} from "./StrokeEngine";

/**
 * Callback invoked by the engine when it needs to drive ElementRenderer's
 * existing geometric-stroke code path. Injected by CanvasLayer wiring.
 */
export type GeometricStrokeRenderFn = (
	pass: GPURenderPassEncoder,
	path: Path,
	alphaMultiplier: number,
	pipelineType: PipelineType,
) => void;

export class GeometricStrokeEngine implements StrokeEngine {
	public readonly ids: readonly BrushType[] = ["stroke"];
	// Geometric stroke is opaque coverage with no wetness model, so it does
	// not emit the wet-ink dynamics field.
	public readonly supportsField = false;

	public constructor(
		private readonly renderViaElementRenderer: GeometricStrokeRenderFn,
	) {}

	public createPipeline(_ctx: EnginePipelineContext): EnginePipeline {
		// Wrapper pipeline — no GPU resources of its own. The geometric path
		// keeps caches / gradient sub-renderer / fringe AA inside ElementRenderer.
		const render: EnginePipeline["render"] = (
			pass,
			style,
			pipelineType,
			_transformsBindGroup,
		) => {
			this.renderViaElementRenderer(
				pass,
				style.legacyPath,
				style.alphaMultiplier,
				pipelineType,
			);
		};
		return {
			render,
			destroy: () => {
				/* no-op — wrapper has no owned GPU resources */
			},
		};
	}
}

/** Default factory used by CanvasLayer wiring. */
export function createGeometricStrokeEngine(
	renderFn: GeometricStrokeRenderFn,
): GeometricStrokeEngine {
	return new GeometricStrokeEngine(renderFn);
}

// Local re-export of ResolvedStrokeStyle so call sites importing from the
// engine file get a stable type without a second import.
export type { ResolvedStrokeStyle };
