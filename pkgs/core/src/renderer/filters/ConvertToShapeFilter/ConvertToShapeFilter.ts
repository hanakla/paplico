import type { Appearance, CubicBezierSegment, Filter } from "../../../schema";
import { applyCornerRadius } from "../../../utils/geometry/generate/cornerRadius";
import {
	generateEllipseSegments,
	generateRectangleSegments,
} from "../../../utils/geometry/generate/shapeSegments";
import { calculateSegmentListBounds } from "../../../utils/geometry/measure/pathBounds";
import type { FilterHandler } from "../../canvas/pipeline/FilterRenderer";

export interface ConvertToShapeParams {
	shape: "rectangle" | "ellipse";
	sizeMode: "relative" | "absolute";
	width: number;
	height: number;
	cornerRadius: number;
}

export interface ConvertToShapeFilter extends Appearance<ConvertToShapeParams> {
	processor: "convert-to-shape";
}

export class ConvertToShapeFilterHandler implements FilterHandler {
	public async initialize(): Promise<void> {}

	public preProcess(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[] {
		const bounds = calculateSegmentListBounds(segments);
		if (!bounds) return segments;
		const params = (filter as ConvertToShapeFilter).paramData.params;
		const width = Math.max(
			0,
			params.sizeMode === "absolute"
				? params.width
				: bounds.width + params.width,
		);
		const height = Math.max(
			0,
			params.sizeMode === "absolute"
				? params.height
				: bounds.height + params.height,
		);
		const centerX = (bounds.minX + bounds.maxX) / 2;
		const centerY = (bounds.minY + bounds.maxY) / 2;
		const start = { x: centerX - width / 2, y: centerY - height / 2 };
		const end = { x: centerX + width / 2, y: centerY + height / 2 };
		if (params.shape === "ellipse") return generateEllipseSegments(start, end);
		const rectangle = generateRectangleSegments(start, end);
		if (params.cornerRadius <= 0) return rectangle;
		return applyCornerRadius(
			rectangle.map((segment) => ({
				...segment,
				cornerRadius: params.cornerRadius,
			})),
		);
	}

	public onScaleFilter(filter: Filter, [x, y]: [number, number]): Filter {
		const params = (filter as ConvertToShapeFilter).paramData.params;
		return {
			...filter,
			paramData: {
				...filter.paramData,
				params: {
					...params,
					width: params.width * Math.abs(x),
					height: params.height * Math.abs(y),
					cornerRadius: params.cornerRadius * Math.sqrt(Math.abs(x * y)),
				},
			},
		};
	}

	public getExpansionMargin(
		filter: Filter,
		bounds?: { width: number; height: number },
	): number {
		const params = (filter as ConvertToShapeFilter).paramData.params;
		if (params.sizeMode === "absolute")
			return Math.max(
				0,
				(params.width - (bounds?.width ?? 0)) / 2,
				(params.height - (bounds?.height ?? 0)) / 2,
			);
		return Math.max(0, params.width / 2, params.height / 2);
	}

	public getBackdropFootprint(): number {
		return 0;
	}
	public getDetailDensity(): number {
		return Number.POSITIVE_INFINITY;
	}
	public onInterpolate(
		a: unknown,
		b: unknown,
		t: number,
	): ConvertToShapeParams {
		const from = a as ConvertToShapeParams;
		const to = b as ConvertToShapeParams;
		return {
			shape: t < 0.5 ? from.shape : to.shape,
			sizeMode: t < 0.5 ? from.sizeMode : to.sizeMode,
			width: from.width + (to.width - from.width) * t,
			height: from.height + (to.height - from.height) * t,
			cornerRadius:
				from.cornerRadius + (to.cornerRadius - from.cornerRadius) * t,
		};
	}
}
