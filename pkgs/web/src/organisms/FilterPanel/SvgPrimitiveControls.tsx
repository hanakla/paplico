import { memo } from "react";
import type {
	SvgBlendFilter,
	SvgColorFunctionFilter,
	SvgColorMatrixFilter,
	SvgComponentTransferFilter,
	SvgCompositeFilter,
	SvgConvolveMatrixFilter,
	SvgDisplacementMapFilter,
	SvgDropShadowFilter,
	SvgFloodFilter,
	SvgGaussianBlurFilter,
	SvgMorphologyFilter,
	SvgOffsetFilter,
	SvgTurbulenceFilter,
} from "@/core/renderer/filters";
import type { Filter } from "@/core/schema";
import { SvgBlendFilterControls } from "./ControlsSvgBlend";
import { SvgColorFunctionFilterControls } from "./ControlsSvgColorFunction";
import { SvgColorMatrixFilterControls } from "./ControlsSvgColorMatrix";
import { SvgComponentTransferFilterControls } from "./ControlsSvgComponentTransfer";
import { SvgCompositeFilterControls } from "./ControlsSvgComposite";
import { SvgConvolveMatrixFilterControls } from "./ControlsSvgConvolveMatrix";
import { SvgDisplacementMapFilterControls } from "./ControlsSvgDisplacementMap";
import { SvgDropShadowFilterControls } from "./ControlsSvgDropShadow";
import { SvgFloodFilterControls } from "./ControlsSvgFlood";
import { SvgGaussianBlurFilterControls } from "./ControlsSvgGaussianBlur";
import { SvgMorphologyFilterControls } from "./ControlsSvgMorphology";
import { SvgOffsetFilterControls } from "./ControlsSvgOffset";
import { SvgTurbulenceFilterControls } from "./ControlsSvgTurbulence";

/** Controls of one `svg:*` primitive, whether it is a filter or a graph node. */
export const SvgPrimitiveControls = memo(function SvgPrimitiveControls({
	filter,
	onUpdate,
}: {
	filter: Filter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	switch (filter.processor) {
		case "svg:gaussian-blur":
			return (
				<SvgGaussianBlurFilterControls
					filter={filter as SvgGaussianBlurFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:offset":
			return (
				<SvgOffsetFilterControls
					filter={filter as SvgOffsetFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:flood":
			return (
				<SvgFloodFilterControls
					filter={filter as SvgFloodFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:color-matrix":
			return (
				<SvgColorMatrixFilterControls
					filter={filter as SvgColorMatrixFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:component-transfer":
			return (
				<SvgComponentTransferFilterControls
					filter={filter as SvgComponentTransferFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:morphology":
			return (
				<SvgMorphologyFilterControls
					filter={filter as SvgMorphologyFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:convolve-matrix":
			return (
				<SvgConvolveMatrixFilterControls
					filter={filter as SvgConvolveMatrixFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:turbulence":
			return (
				<SvgTurbulenceFilterControls
					filter={filter as SvgTurbulenceFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:displacement-map":
			return (
				<SvgDisplacementMapFilterControls
					filter={filter as SvgDisplacementMapFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:composite":
			return (
				<SvgCompositeFilterControls
					filter={filter as SvgCompositeFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:blend":
			return (
				<SvgBlendFilterControls
					filter={filter as SvgBlendFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:drop-shadow":
			return (
				<SvgDropShadowFilterControls
					filter={filter as SvgDropShadowFilter}
					onUpdate={onUpdate}
				/>
			);
		case "svg:saturate":
		case "svg:hue-rotate":
		case "svg:grayscale":
		case "svg:sepia":
		case "svg:invert":
		case "svg:brightness":
		case "svg:contrast":
			return (
				<SvgColorFunctionFilterControls
					filter={filter as SvgColorFunctionFilter}
					onUpdate={onUpdate}
				/>
			);
		default:
			return null;
	}
});
