/**
 * StampStrokeEngine — owns BrushTypes `scatter` and `calligraphy`.
 *
 * Drives the stamp pipeline (BRUSH_STAMP_SHADER / BRUSH_STAMP_ARRAY_SHADER)
 * hosted on the shared StrokeBatchContext. Scatter brushes feed the pipeline
 * directly; calligraphy brushes feed it through a forward adapter inside
 * StrokeBatchContext that maps roundness / nibAngle onto stamp sizeY +
 * rotation (elliptical nib via texture scaling).
 *
 * `supportsField=true` so the wet-ink pass can pick this engine to write
 * into the per-stroke dynamics field once the field-writing pipeline
 * variant is wired up.
 */

import type { BrushType } from "../../../../schema";
import type { StrokeBatchContext } from "./StrokeBatchContext";
import type {
	EnginePipeline,
	EnginePipelineContext,
	StrokeEngine,
} from "./StrokeEngine";

export const STAMP_BRUSH_TYPES: readonly BrushType[] = [
	"scatter",
	"calligraphy",
];

export class StampStrokeEngine implements StrokeEngine {
	public readonly ids = STAMP_BRUSH_TYPES;
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
