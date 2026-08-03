/**
 * RibbonStrokeEngine — owns BrushTypes `art` and `pattern`.
 *
 * Drives the ribbon pipeline (RIBBON_STROKE_SHADER) hosted on the shared
 * StrokeBatchContext. Pattern brushes feed the pipeline with uvMode=repeat
 * (and tileSpacing for inter-tile gaps); art brushes go through a forward
 * adapter inside StrokeBatchContext that synthesizes a PatternBrushSettings
 * shape with uvMode=stretch + per-instance flip flags.
 *
 * supportsField=false because art / pattern do not carry a wetness model
 * in the BrushSettings union, so the wet-ink path skips them.
 */

import type { BrushType } from "../../../../schema";
import type { StrokeBatchContext } from "./StrokeBatchContext";
import type {
	EnginePipeline,
	EnginePipelineContext,
	StrokeEngine,
} from "./StrokeEngine";

export class RibbonStrokeEngine implements StrokeEngine {
	public readonly ids: readonly BrushType[] = ["art", "pattern"];
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
