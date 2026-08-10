/**
 * RibbonStrokeEngine — owns the ribbon engine.
 *
 * Drives the ribbon pipeline (RIBBON_STROKE_SHADER) hosted on the shared
 * StrokeBatchContext. The brush's RibbonConfig decides the UV layout: repeat
 * tiles the texture along the stroke (with tileSpacing for inter-tile gaps),
 * stretch spans it once end to end with per-instance flip flags.
 *
 * supportsField=false because the wet layer is a dab-engine feature; a ribbon
 * stroke skips it.
 */

import type { BrushEngineKind } from "../../../../schema";
import type { StrokeBatchContext } from "./StrokeBatchContext";
import type {
	EnginePipeline,
	EnginePipelineContext,
	StrokeEngine,
} from "./StrokeEngine";

export class RibbonStrokeEngine implements StrokeEngine {
	public readonly ids: readonly BrushEngineKind[] = ["ribbon"];
	public readonly supportsField = false;

	public constructor(private readonly context: StrokeBatchContext) {}

	public createPipeline(_ctx: EnginePipelineContext): EnginePipeline {
		const context = this.context;
		return {
			render: (pass, style, pipelineType, transformsBindGroup) => {
				context.render(
					pass,
					style.legacyPath,
					style.alphaMultiplier,
					pipelineType,
					style.segments,
					transformsBindGroup,
					style.transformIndex,
				);
			},
			addToBatch: (style, transformIndex) => {
				context.addToBatch(
					style.legacyPath,
					style.segments,
					style.alphaMultiplier,
					transformIndex,
				);
				return true;
			},
			destroy: () => {
				/* context is shared and owned by the registry */
			},
		};
	}
}

export function createRibbonStrokeEngine(
	context: StrokeBatchContext,
): RibbonStrokeEngine {
	return new RibbonStrokeEngine(context);
}
