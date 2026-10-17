import type {
	CompoundPath,
	CubicBezierSegment,
	FillAppearance,
	FillColor,
	Filter,
	Path,
	StrokeAppearance,
} from "../../schema";
import { localAppearances } from "../appearancePresets";
import { createIdentityTransform } from "../factory";

const MASK_FILL: FillColor = {
	type: "solid",
	color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
};

export function createCompoundPathRenderPath(
	compoundPath: CompoundPath,
	segments: CubicBezierSegment[],
	preFilters: readonly Filter[],
	isMaskRender = false,
): Path {
	const cpFill = (
		localAppearances(compoundPath.filters).find(
			(f) => f.processor === "fill" && f.enabled !== false,
		) as FillAppearance | undefined
	)?.paramData.params.fill;
	const cpStroke = isMaskRender
		? undefined
		: (localAppearances(compoundPath.filters).find(
				(f) => f.processor === "stroke" && f.enabled !== false,
			) as StrokeAppearance | undefined);
	const fill = isMaskRender ? (cpFill ?? MASK_FILL) : cpFill;

	const filters: Filter[] = [...preFilters];
	if (cpStroke) {
		filters.push({
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: cpStroke.paramData.params },
		} as StrokeAppearance);
	}
	if (fill) {
		filters.push({
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill } },
		} as FillAppearance);
	}

	return {
		type: "path",
		id: `${compoundPath.id}-render`,
		opacity: compoundPath.opacity,
		blendMode: compoundPath.blendMode,
		segments,
		filters,
		transform: createIdentityTransform(),
	};
}
