// Public type barrel for userland (outside core/) filter type imports.
// Filter processor/handler files own their Params + Filter interfaces;
// code inside core/ imports them directly from the owning module.

// --- Post-Filters (Image Processing) ---
export type {
	BlurFilter,
	BlurParams,
} from "./BlurFilterProcessor";
export type {
	DropShadowFilter,
	DropShadowParams,
} from "./DropShadowFilterProcessor";
export type {
	FrostGlassFilter,
	FrostGlassParams,
} from "./FrostGlassFilterProcessor";
export type {
	HKBloomFilter,
	HKBloomParams,
} from "./hanakla-kit/HKBloomHandler";
// --- Hanakla Kit: Stylize ---
export type {
	HKBlushStrokeFilter,
	HKBlushStrokeParams,
} from "./hanakla-kit/HKBlushStrokeHandler";
export type {
	HKChromaticAberrationFilter,
	HKChromaticAberrationParams,
} from "./hanakla-kit/HKChromaticAberrationHandler";
export type {
	HKColorReplacementFilter,
	HKColorReplacementParams,
} from "./hanakla-kit/HKColorReplacementHandler";
export type {
	HKComicToneFilter,
	HKComicToneParams,
} from "./hanakla-kit/HKComicToneHandler";
export type {
	HKDirectionalBlurFilter,
	HKDirectionalBlurParams,
} from "./hanakla-kit/HKDirectionalBlurHandler";
// --- Hanakla Kit: Distortion ---
export type {
	HKFluidFilter,
	HKFluidParams,
} from "./hanakla-kit/HKFluidHandler";
export type {
	HKGlitchFilter,
	HKGlitchParams,
} from "./hanakla-kit/HKGlitchHandler";
// --- Hanakla Kit: Color ---
export {
	GRADIENT_MAP_PRESET_STOPS,
	type HKGradientMapFilter,
	type HKGradientMapParams,
} from "./hanakla-kit/HKGradientMapHandler";
export type {
	HKHalftoneFilter,
	HKHalftoneParams,
} from "./hanakla-kit/HKHalftoneHandler";
// --- Hanakla Kit: Other ---
export type {
	HKHuskyFilter,
	HKHuskyParams,
} from "./hanakla-kit/HKHuskyHandler";
export type {
	HKInnerGlowFilter,
	HKInnerGlowParams,
} from "./hanakla-kit/HKInnerGlowHandler";
export type {
	HKKaleidoscopeFilter,
	HKKaleidoscopeParams,
} from "./hanakla-kit/HKKaleidoscopeHandler";
export type {
	HKKirakiraFilter,
	HKKirakiraParams,
} from "./hanakla-kit/HKKirakiraHandler";
export type {
	HKOutlineFilter,
	HKOutlineParams,
} from "./hanakla-kit/HKOutlineHandler";
// --- Hanakla Kit: Texture ---
export type {
	HKPaperV2Filter,
	HKPaperV2Params,
} from "./hanakla-kit/HKPaperV2Handler";
export type {
	HKPixelSortFilter,
	HKPixelSortParams,
} from "./hanakla-kit/HKPixelSortHandler";
export type {
	HKPosterizationFilter,
	HKPosterizationParams,
} from "./hanakla-kit/HKPosterizationHandler";
export type {
	HKRadialRotDirFilter,
	HKRadialRotDirParams,
} from "./hanakla-kit/HKRadialRotDirHandler";
export type {
	HKSelectiveCorrectionFilter,
	HKSelectiveCorrectionParams,
} from "./hanakla-kit/HKSelectiveCorrectionHandler";
export type {
	HKSmearFilter,
	HKSmearParams,
} from "./hanakla-kit/HKSmearHandler";
export type {
	HKSprayingFilter,
	HKSprayingParams,
} from "./hanakla-kit/HKSprayingHandler";
export type {
	HKTurbulenceFilter,
	HKTurbulenceParams,
} from "./hanakla-kit/HKTurbulenceHandler";
export type {
	HKVhsInterlaceFilter,
	HKVhsInterlaceParams,
} from "./hanakla-kit/HKVhsInterlaceHandler";
export type {
	HKWaveFilter,
	HKWaveParams,
} from "./hanakla-kit/HKWaveHandler";
export type {
	PathOffsetFilter,
	PathOffsetParams,
} from "./PathOffsetFilterProcessor";
export type {
	PathUnionFilter,
	PathUnionParams,
} from "./PathUnionFilterProcessor";
export type {
	PixelateFilter,
	PixelateParams,
} from "./PixelateFilterProcessor";
export type {
	PuckerBloatFilter,
	PuckerBloatParams,
} from "./PuckerBloatFilterProcessor";
// --- Transform ---
export type {
	Rotate3DFilter,
	Rotate3DParams,
} from "./Rotate3DFilterProcessor";
// --- Pre-Filters (Geometry) ---
export type {
	ZigzagFilter,
	ZigzagParams,
} from "./ZigzagFilterProcessor";
