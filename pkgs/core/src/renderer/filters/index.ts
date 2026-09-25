// Public barrel for @paplico/core/filters.
// Filter processor/handler files own their Params + Filter interfaces;
// code inside the package imports them directly from the owning module.

// --- Post-Filters (Image Processing) ---
export type {
	BlurFilter,
	BlurParams,
} from "./BlurFilter/BlurFilter";
export type {
	ClipToShapeFilter,
	ClipToShapeParams,
} from "./ClipToShapeFilter/ClipToShapeFilter";
export type {
	DropShadowFilter,
	DropShadowParams,
} from "./DropShadowFilter/DropShadowFilter";
export type {
	FrostGlassFilter,
	FrostGlassParams,
} from "./FrostGlassFilter/FrostGlassFilter";
export { FILTER_CATALOG } from "./filterCatalog";
export type {
	HKBloomFilter,
	HKBloomParams,
} from "./HKBloomFilter/HKBloomFilter";
// --- Hanakla Kit: Stylize ---
export type {
	HKBlushStrokeFilter,
	HKBlushStrokeParams,
} from "./HKBlushStrokeFilter/HKBlushStrokeFilter";
export type {
	HKChromaticAberrationFilter,
	HKChromaticAberrationParams,
} from "./HKChromaticAberrationFilter/HKChromaticAberrationFilter";
export type {
	HKColorReplacementFilter,
	HKColorReplacementParams,
} from "./HKColorReplacementFilter/HKColorReplacementFilter";
export type {
	HKComicToneFilter,
	HKComicToneParams,
} from "./HKComicToneFilter/HKComicToneFilter";
export type {
	HKDirectionalBlurFilter,
	HKDirectionalBlurParams,
} from "./HKDirectionalBlurFilter/HKDirectionalBlurFilter";
// --- Hanakla Kit: Distortion ---
export type {
	HKFluidFilter,
	HKFluidParams,
} from "./HKFluidFilter/HKFluidFilter";
export type {
	HKGlitchFilter,
	HKGlitchParams,
} from "./HKGlitchFilter/HKGlitchFilter";
// --- Hanakla Kit: Color ---
export {
	GRADIENT_MAP_PRESET_STOPS,
	type HKGradientMapFilter,
	type HKGradientMapParams,
} from "./HKGradientMapFilter/HKGradientMapFilter";
export type {
	HKHalftoneFilter,
	HKHalftoneParams,
} from "./HKHalftoneFilter/HKHalftoneFilter";
// --- Hanakla Kit: Other ---
export type {
	HKHuskyFilter,
	HKHuskyParams,
} from "./HKHuskyFilter/HKHuskyFilter";
export type {
	HKInnerGlowFilter,
	HKInnerGlowParams,
} from "./HKInnerGlowFilter/HKInnerGlowFilter";
export type {
	HKKaleidoscopeFilter,
	HKKaleidoscopeParams,
} from "./HKKaleidoscopeFilter/HKKaleidoscopeFilter";
export type {
	HKKirakiraFilter,
	HKKirakiraParams,
} from "./HKKirakiraFilter/HKKirakiraFilter";
export type {
	HKOutlineFilter,
	HKOutlineParams,
} from "./HKOutlineFilter/HKOutlineFilter";
// --- Hanakla Kit: Texture ---
export type {
	HKPaperV2Filter,
	HKPaperV2Params,
} from "./HKPaperV2Filter/HKPaperV2Filter";
export type {
	HKPixelSortFilter,
	HKPixelSortParams,
} from "./HKPixelSortFilter/HKPixelSortFilter";
export type {
	HKPosterizationFilter,
	HKPosterizationParams,
} from "./HKPosterizationFilter/HKPosterizationFilter";
export type {
	HKRadialRotDirFilter,
	HKRadialRotDirParams,
} from "./HKRadialRotDirFilter/HKRadialRotDirFilter";
export type {
	HKSelectiveCorrectionFilter,
	HKSelectiveCorrectionParams,
} from "./HKSelectiveCorrectionFilter/HKSelectiveCorrectionFilter";
export type {
	HKSmearFilter,
	HKSmearParams,
} from "./HKSmearFilter/HKSmearFilter";
export type {
	HKSprayingFilter,
	HKSprayingParams,
} from "./HKSprayingFilter/HKSprayingFilter";
export type {
	HKTurbulenceFilter,
	HKTurbulenceParams,
} from "./HKTurbulenceFilter/HKTurbulenceFilter";
export type {
	HKVhsInterlaceFilter,
	HKVhsInterlaceParams,
} from "./HKVhsInterlaceFilter/HKVhsInterlaceFilter";
export type {
	HKWaveFilter,
	HKWaveParams,
} from "./HKWaveFilter/HKWaveFilter";
export type {
	NoiseFilter,
	NoiseParams,
} from "./NoiseFilter/NoiseFilter";
export type {
	PathOffsetFilter,
	PathOffsetParams,
} from "./PathOffsetFilter/PathOffsetFilter";
export type {
	PathUnionFilter,
	PathUnionParams,
} from "./PathUnionFilter/PathUnionFilter";
export type {
	PixelateFilter,
	PixelateParams,
} from "./PixelateFilter/PixelateFilter";
export type {
	PuckerBloatFilter,
	PuckerBloatParams,
} from "./PuckerBloatFilter/PuckerBloatFilter";
// --- Transform ---
export type {
	Rotate3DFilter,
	Rotate3DParams,
} from "./Rotate3DFilter/Rotate3DFilter";
// --- Pre-Filters (Geometry) ---
export type { RoughFilter, RoughParams } from "./RoughFilter/RoughFilter";
// --- SVG filter primitives ---
export type {
	SvgBlendFilter,
	SvgBlendParams,
} from "./svg/SvgBlendFilter/SvgBlendFilter";
export {
	SVG_COLOR_FUNCTIONS,
	type SvgColorFunction,
	type SvgColorFunctionFilter,
	type SvgColorFunctionParams,
} from "./svg/SvgColorFunctionFilter/SvgColorFunctionFilter";
export {
	SVG_COLOR_MATRIX_IDENTITY,
	type SvgColorMatrixFilter,
	type SvgColorMatrixParams,
	type SvgColorMatrixType,
} from "./svg/SvgColorMatrixFilter/SvgColorMatrixFilter";
export type {
	SvgComponentTransferFilter,
	SvgComponentTransferParams,
	SvgTransferFunction,
} from "./svg/SvgComponentTransferFilter/SvgComponentTransferFilter";
export type {
	SvgCompositeFilter,
	SvgCompositeOperator,
	SvgCompositeParams,
} from "./svg/SvgCompositeFilter/SvgCompositeFilter";
export type {
	SvgConvolveMatrixFilter,
	SvgConvolveMatrixParams,
} from "./svg/SvgConvolveMatrixFilter/SvgConvolveMatrixFilter";
export type {
	SvgChannelSelector,
	SvgDisplacementMapFilter,
	SvgDisplacementMapParams,
} from "./svg/SvgDisplacementMapFilter/SvgDisplacementMapFilter";
export type {
	SvgDropShadowFilter,
	SvgDropShadowParams,
} from "./svg/SvgDropShadowFilter/SvgDropShadowFilter";
export type {
	SvgFilterGraphFilter,
	SvgFilterGraphParams,
	SvgFilterNode,
} from "./svg/SvgFilterGraphFilter/SvgFilterGraphFilter";
export { isSvgFilterNodeEnabled } from "./svg/SvgFilterGraphFilter/SvgFilterGraphFilter";
export type {
	SvgFloodFilter,
	SvgFloodParams,
} from "./svg/SvgFloodFilter/SvgFloodFilter";
export type {
	SvgGaussianBlurFilter,
	SvgGaussianBlurParams,
} from "./svg/SvgGaussianBlurFilter/SvgGaussianBlurFilter";
export type {
	SvgMorphologyFilter,
	SvgMorphologyParams,
} from "./svg/SvgMorphologyFilter/SvgMorphologyFilter";
export type {
	SvgOffsetFilter,
	SvgOffsetParams,
} from "./svg/SvgOffsetFilter/SvgOffsetFilter";
export type {
	SvgTurbulenceFilter,
	SvgTurbulenceParams,
} from "./svg/SvgTurbulenceFilter/SvgTurbulenceFilter";
export {
	type SvgFilterInput,
	svgInputNodeRef,
	svgNodeRefInput,
} from "./svg/svgFilterInput";
export type {
	TransformFilter,
	TransformOrigin,
	TransformParams,
} from "./TransformFilter/TransformFilter";
export type {
	ZigzagFilter,
	ZigzagParams,
} from "./ZigzagFilter/ZigzagFilter";
