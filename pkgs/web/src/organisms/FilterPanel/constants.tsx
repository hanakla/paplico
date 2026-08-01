import {
	Activity,
	Box,
	Cylinder,
	Diamond,
	Droplets,
	Expand,
	Filter,
	Grip,
	Image,
	type LucideIcon,
	Merge,
	PaintBucket,
	Palette,
	Pen,
	Sparkles,
	Spline,
	Type,
	Waves,
} from "lucide-react";
import { FILTER_CATALOG } from "@/core/renderer/filters/filterCatalog";
import type {
	AnyArtObject,
	FillAppearance,
	FillColor,
	StrokeAppearance,
	StrokeColor,
} from "@/core/schema";
import type { LocalizeKeys } from "@/locales";

export const FILTER_TEXT_KEYS = {
	fill: "filterPanel.fill",
	stroke: "filterPanel.stroke",
	content: "filterPanel.content",
	blur: "filterPanel.blur",
	"frost-glass": "filterPanel.frostGlass",
	zigzag: "filterPanel.zigzag",
	"drop-shadow": "filterPanel.dropShadow",
	pixelate: "filterPanel.pixelate",
	"path-offset": "filterPanel.pathOffset",
	"path-union": "filterPanel.pathUnion",
	"pucker-bloat": "filterPanel.puckerBloat",
	"3d-rotate": "filterPanel.rotate3d",
	extrude3d: "filterPanel.extrude3d",
	revolve3d: "filterPanel.revolve3d",
	"hk:bloom": "filterPanel.hk.bloom",
	"hk:directional-blur": "filterPanel.hk.directionalBlur",
	"hk:kirakira": "filterPanel.hk.kirakira",
	"hk:radial-rot-dir": "filterPanel.hk.radialRotDir",
	"hk:gradient-map": "filterPanel.hk.gradientMap",
	"hk:posterization": "filterPanel.hk.posterization",
	"hk:color-replacement": "filterPanel.hk.colorReplacement",
	"hk:selective-correction": "filterPanel.hk.colorCorrection",
	"hk:fluid": "filterPanel.hk.fluid",
	"hk:glitch": "filterPanel.hk.glitch",
	"hk:smear": "filterPanel.hk.smear",
	"hk:spraying": "filterPanel.hk.spraying",
	"hk:turbulence": "filterPanel.hk.turbulence",
	"hk:wave": "filterPanel.hk.wave",
	"hk:blush-stroke": "filterPanel.hk.blushStroke",
	"hk:chromatic-aberration": "filterPanel.hk.chromaticAberration",
	"hk:comic-tone": "filterPanel.hk.comicTone",
	"hk:halftone": "filterPanel.hk.halftone",
	"hk:inner-glow": "filterPanel.hk.innerGlow",
	"hk:outline": "filterPanel.hk.outline",
	"hk:vhs-interlace": "filterPanel.hk.vhsInterlace",
	"hk:paper-v2": "filterPanel.hk.paperV2",
	"hk:husky": "filterPanel.hk.husky",
	"hk:kaleidoscope": "filterPanel.hk.kaleidoscope",
	"hk:pixel-sort": "filterPanel.hk.pixelSort",
} as const;

/** Raster filter categories share one icon each; Appearance / Geometry / 3D
 *  keep per-processor icons. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
	Blur: Droplets,
	Color: Palette,
	Stylize: Sparkles,
	Distortion: Waves,
	Texture: Grip,
};

const PROCESSOR_CATEGORIES = new Map(
	FILTER_CATALOG.map((entry) => [entry.processor, entry.category]),
);

export function getFilterIcon(processor: string) {
	const CategoryIcon =
		CATEGORY_ICONS[PROCESSOR_CATEGORIES.get(processor) ?? ""];
	if (CategoryIcon) {
		return <CategoryIcon size={12} className="text-muted-foreground" />;
	}

	switch (processor) {
		case "fill":
			return <PaintBucket size={12} className="text-muted-foreground" />;
		case "stroke":
			return <Pen size={12} className="text-muted-foreground" />;
		case "content":
			return <Type size={12} className="text-muted-foreground" />;
		case "zigzag":
			return <Activity size={12} className="text-muted-foreground" />;
		case "path-offset":
			return <Expand size={12} className="text-muted-foreground" />;
		case "path-union":
			return <Merge size={12} className="text-muted-foreground" />;
		case "pucker-bloat":
			return <Diamond size={12} className="text-muted-foreground" />;
		case "extrude3d":
			return <Box size={12} className="text-muted-foreground" />;
		case "revolve3d":
			return <Cylinder size={12} className="text-muted-foreground" />;
		default:
			return <Filter size={12} className="text-muted-foreground" />;
	}
}

const ELEMENT_TYPE_LABELS = {
	path: "common.path",
	image: "common.image",
	group: "common.group",
	text: "common.text",
	"compound-path": "common.compoundPath",
} satisfies Partial<Record<AnyArtObject["type"], LocalizeKeys>>;

export function getElementTypeLabelKey(
	type: AnyArtObject["type"],
): LocalizeKeys {
	return ELEMENT_TYPE_LABELS[type] ?? "common.element";
}

export function getElementTypeIcon(type: string) {
	switch (type) {
		case "path":
		case "compound-path":
			return <Spline size={12} className="text-muted-foreground" />;
		case "image":
			return <Image size={12} className="text-muted-foreground" />;
		case "text":
			return <Type size={12} className="text-muted-foreground" />;
		default:
			return <Filter size={12} className="text-muted-foreground" />;
	}
}

export function getAppearanceColor(filter: FillAppearance | StrokeAppearance): {
	color: FillColor | StrokeColor | null;
	variant: "fill" | "stroke";
} {
	if (filter.processor === "fill") {
		return {
			color: filter.paramData?.params?.fill ?? null,
			variant: "fill",
		};
	}
	if (filter.processor === "stroke") {
		return {
			color: filter.paramData?.params?.strokeColor ?? null,
			variant: "stroke",
		};
	}
	return { color: null, variant: "fill" };
}
