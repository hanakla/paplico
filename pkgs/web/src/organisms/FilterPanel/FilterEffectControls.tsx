import { memo } from "react";
import type {
	BlurFilter,
	DropShadowFilter,
	FrostGlassFilter,
	HKBloomFilter,
	HKBlushStrokeFilter,
	HKChromaticAberrationFilter,
	HKColorReplacementFilter,
	HKComicToneFilter,
	HKDirectionalBlurFilter,
	HKFluidFilter,
	HKGlitchFilter,
	HKGradientMapFilter,
	HKHalftoneFilter,
	HKHuskyFilter,
	HKInnerGlowFilter,
	HKKaleidoscopeFilter,
	HKKirakiraFilter,
	HKOutlineFilter,
	HKPaperV2Filter,
	HKPixelSortFilter,
	HKPosterizationFilter,
	HKRadialRotDirFilter,
	HKSelectiveCorrectionFilter,
	HKSmearFilter,
	HKSprayingFilter,
	HKTurbulenceFilter,
	HKVhsInterlaceFilter,
	HKWaveFilter,
	PathOffsetFilter,
	PathUnionFilter,
	PixelateFilter,
	PuckerBloatFilter,
	Rotate3DFilter,
	ZigzagFilter,
} from "@/core/renderer/filters";
import type {
	Extrude3DAppearance,
	Filter as FilterType,
	Revolve3DAppearance,
} from "@/core/schema";
import { BloomFilterControls } from "./ControlsBloom";
import { BlurFilterControls } from "./ControlsBlur";
import { BlushStrokeFilterControls } from "./ControlsBlushStroke";
import { ChromaticAberrationFilterControls } from "./ControlsChromaticAberration";
import { ColorReplacementFilterControls } from "./ControlsColorReplacement";
import { ComicToneFilterControls } from "./ControlsComicTone";
import { DirectionalBlurFilterControls } from "./ControlsDirectionalBlur";
import { DropShadowFilterControls } from "./ControlsDropShadow";
import { Extrude3DFilterControls } from "./ControlsExtrude3D";
import { FluidFilterControls } from "./ControlsFluid";
import { FrostGlassFilterControls } from "./ControlsFrostGlass";
import { GlitchFilterControls } from "./ControlsGlitch";
import { GradientMapFilterControls } from "./ControlsGradientMap";
import { HalftoneFilterControls } from "./ControlsHalftone";
import { HuskyFilterControls } from "./ControlsHusky";
import { InnerGlowFilterControls } from "./ControlsInnerGlow";
import { KaleidoscopeFilterControls } from "./ControlsKaleidoscope";
import { KirakiraFilterControls } from "./ControlsKirakira";
import { OutlineFilterControls } from "./ControlsOutline";
import { PaperTextureFilterControls } from "./ControlsPaperTexture";
import { PathOffsetFilterControls } from "./ControlsPathOffset";
import { PathUnionFilterControls } from "./ControlsPathUnion";
import { PixelateFilterControls } from "./ControlsPixelate";
import { PixelSortFilterControls } from "./ControlsPixelSort";
import { PosterizationFilterControls } from "./ControlsPosterization";
import { PuckerBloatFilterControls } from "./ControlsPuckerBloat";
import { RadialRotDirFilterControls } from "./ControlsRadialRotDir";
import { Revolve3DFilterControls } from "./ControlsRevolve3D";
import { Rotate3DFilterControls } from "./ControlsRotate3D";
import { SelectiveCorrectionFilterControls } from "./ControlsSelectiveCorrection";
import { SmearFilterControls } from "./ControlsSmear";
import { SprayingFilterControls } from "./ControlsSpraying";
import { TurbulenceFilterControls } from "./ControlsTurbulence";
import { VhsInterlaceFilterControls } from "./ControlsVhsInterlace";
import { WaveFilterControls } from "./ControlsWave";
import { ZigzagFilterControls } from "./ControlsZigzag";

export const FilterEffectControls = memo(function FilterEffectControls({
	filter,
	onUpdate,
}: {
	filter: FilterType;
	onUpdate: (params: Record<string, unknown>) => void;
}) {
	if (filter.processor === "blur") {
		return (
			<BlurFilterControls filter={filter as BlurFilter} onUpdate={onUpdate} />
		);
	}
	if (filter.processor === "frost-glass") {
		return (
			<FrostGlassFilterControls
				filter={filter as FrostGlassFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "zigzag") {
		return (
			<ZigzagFilterControls
				filter={filter as ZigzagFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "drop-shadow") {
		return (
			<DropShadowFilterControls
				filter={filter as DropShadowFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "pixelate") {
		return (
			<PixelateFilterControls
				filter={filter as PixelateFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "path-offset") {
		return (
			<PathOffsetFilterControls
				filter={filter as PathOffsetFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "path-union") {
		return (
			<PathUnionFilterControls
				filter={filter as PathUnionFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "pucker-bloat") {
		return (
			<PuckerBloatFilterControls
				filter={filter as PuckerBloatFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "3d-rotate") {
		return (
			<Rotate3DFilterControls
				filter={filter as Rotate3DFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "extrude3d") {
		return (
			<Extrude3DFilterControls
				filter={filter as Extrude3DAppearance}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "revolve3d") {
		return (
			<Revolve3DFilterControls
				filter={filter as Revolve3DAppearance}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:chromatic-aberration") {
		return (
			<ChromaticAberrationFilterControls
				filter={filter as HKChromaticAberrationFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:husky") {
		return (
			<HuskyFilterControls
				filter={filter as HKHuskyFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:spraying") {
		return (
			<SprayingFilterControls
				filter={filter as HKSprayingFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:smear") {
		return (
			<SmearFilterControls
				filter={filter as HKSmearFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:blush-stroke") {
		return (
			<BlushStrokeFilterControls
				filter={filter as HKBlushStrokeFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:comic-tone") {
		return (
			<ComicToneFilterControls
				filter={filter as HKComicToneFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:halftone") {
		return (
			<HalftoneFilterControls
				filter={filter as HKHalftoneFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:inner-glow") {
		return (
			<InnerGlowFilterControls
				filter={filter as HKInnerGlowFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:outline") {
		return (
			<OutlineFilterControls
				filter={filter as HKOutlineFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:vhs-interlace") {
		return (
			<VhsInterlaceFilterControls
				filter={filter as HKVhsInterlaceFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:paper-v2") {
		return (
			<PaperTextureFilterControls
				filter={filter as HKPaperV2Filter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:pixel-sort") {
		return (
			<PixelSortFilterControls
				filter={filter as HKPixelSortFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:fluid") {
		return (
			<FluidFilterControls
				filter={filter as HKFluidFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:glitch") {
		return (
			<GlitchFilterControls
				filter={filter as HKGlitchFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:turbulence") {
		return (
			<TurbulenceFilterControls
				filter={filter as HKTurbulenceFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:wave") {
		return (
			<WaveFilterControls filter={filter as HKWaveFilter} onUpdate={onUpdate} />
		);
	}
	if (filter.processor === "hk:bloom") {
		return (
			<BloomFilterControls
				filter={filter as HKBloomFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:directional-blur") {
		return (
			<DirectionalBlurFilterControls
				filter={filter as HKDirectionalBlurFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:kirakira") {
		return (
			<KirakiraFilterControls
				filter={filter as HKKirakiraFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:radial-rot-dir") {
		return (
			<RadialRotDirFilterControls
				filter={filter as HKRadialRotDirFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:gradient-map") {
		return (
			<GradientMapFilterControls
				filter={filter as HKGradientMapFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:posterization") {
		return (
			<PosterizationFilterControls
				filter={filter as HKPosterizationFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:color-replacement") {
		return (
			<ColorReplacementFilterControls
				filter={filter as HKColorReplacementFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:selective-correction") {
		return (
			<SelectiveCorrectionFilterControls
				filter={filter as HKSelectiveCorrectionFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	if (filter.processor === "hk:kaleidoscope") {
		return (
			<KaleidoscopeFilterControls
				filter={filter as HKKaleidoscopeFilter}
				onUpdate={onUpdate}
			/>
		);
	}
	return null;
});
