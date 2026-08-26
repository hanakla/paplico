/**
 * StampStrokeEngine — owns the dab engine.
 *
 * Drives the dab pipelines (buildBrushDabShader, one variant per tip mode)
 * hosted on the shared StrokeBatchContext. Tip shape, nib ellipticity and
 * rotation all arrive as BrushSettingsV2 properties, so this engine only
 * forwards; DabEvaluator resolves them per dab.
 *
 * `supportsField=true` so the wet layer can pick this engine to seed the
 * per-stroke dynamics field.
 */

import type { BrushEngineKind } from "../../../../schema";
import type { StrokeBatchContext } from "./StrokeBatchContext";
import type {
	EnginePipeline,
	EnginePipelineContext,
	StrokeEngine,
} from "./StrokeEngine";

export class StampStrokeEngine implements StrokeEngine {
	public readonly ids: readonly BrushEngineKind[] = ["dab"];
	public readonly supportsField = true;

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

export function createStampStrokeEngine(
	context: StrokeBatchContext,
): StampStrokeEngine {
	return new StampStrokeEngine(context);
}
