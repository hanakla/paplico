/**
 * Stroke Outline Pre-Filter Processor
 * Replaces a geometric stroke with a fill of the band it paints, so the
 * geometry filters after it act on the band's outline instead of the
 * centerline. Anything it cannot outline passes through unchanged.
 */

import {
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../../document/factory";
import type { CubicBezierSegment, Filter } from "../../schema";
import { hashSegments } from "../../utils/geometry/segmentOps";
import {
	type GeometricStrokeShape,
	isOutlinableStroke,
	outlineGeometricStroke,
	resolveGeometricStrokeShape,
	strokeToFill,
} from "../canvas/elements/geometricStroke";
import type {
	AppearanceGeometry,
	FilterHandler,
} from "../canvas/pipeline/FilterRenderer";

/** Outline memo capacity: one entry per outlined stroke drawn recently. */
const RESULT_CACHE_LIMIT = 64;

export class StrokeOutlineFilterHandler implements FilterHandler {
	/**
	 * Outlining fits curves to a triangle soup and costs tens of ms, while the
	 * pipeline hands the hook a fresh copy of the segments every frame. The
	 * memo is keyed by the segments' content and the band they draw, so a
	 * redraw of the same stroke is a hash lookup and any edit to its width,
	 * profile or shape misses. Insertion-ordered; oldest evicted past the cap.
	 */
	private readonly outlined = new Map<string, CubicBezierSegment[]>();

	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op: Pre-filter does not use GPU pipelines */
	}

	public preProcessAppearance(
		geometry: AppearanceGeometry,
		_filter: Filter,
	): AppearanceGeometry[] {
		const stroke = geometry.appearance;
		if (!stroke || !isOutlinableStroke(stroke)) return [geometry];
		const shape = resolveGeometricStrokeShape(
			geometry.path,
			stroke.paramData.params.brushSettings ?? createStrokeBrushSettings(1),
		);
		// The band is a fill of its own outline, so the profile that shaped it
		// does not carry over.
		return [
			{
				...geometry,
				appearance: strokeToFill(stroke),
				path: { segments: this.outline(geometry.path.segments, shape) },
			},
		];
	}

	public onScaleFilter(params: Filter, _scale: [number, number]): Filter {
		return params;
	}

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	/** The band's outline, fitted at the document's own scale. */
	private outline(
		segments: CubicBezierSegment[],
		shape: GeometricStrokeShape,
	): CubicBezierSegment[] {
		const key = `${hashSegments(segments)}:${segments.length}:${JSON.stringify(shape)}`;
		const cached = this.outlined.get(key);
		if (cached) {
			this.outlined.delete(key);
			this.outlined.set(key, cached);
			return cached;
		}
		const outlined = outlineGeometricStroke(
			[segments],
			shape,
			createIdentityTransform(),
		);
		this.outlined.set(key, outlined);
		if (this.outlined.size > RESULT_CACHE_LIMIT) {
			const oldest = this.outlined.keys().next().value;
			if (oldest !== undefined) this.outlined.delete(oldest);
		}
		return outlined;
	}
}
