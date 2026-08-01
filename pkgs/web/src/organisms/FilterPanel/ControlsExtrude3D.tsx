import { memo, useMemo } from "react";
import { Accordion } from "@/components/Accordion";
import { Checkbox } from "@/components/Checkbox";
import { SimpleSelect } from "@/components/SimpleSelect";
import type {
	Color,
	Extrude3DAppearance,
	FillColor,
	Material3D,
	Vec3,
} from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FilterColorSwatch } from "./FilterColorSwatch";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import {
	azimuthDegOf,
	elevationDegOf,
	FRESNEL_SLIDERS,
	GLASS_SLIDERS,
	LIGHT_AND_SPECULAR_SLIDERS,
	LIGHT_SLIDERS,
	lightDirFromAngles,
	MaterialPatternSwatch,
	NEUTRAL_SHADOW,
	PBR_SLIDERS,
	ROTATION_SLIDERS,
	Section,
	SURFACE_TEXTURE_SLIDERS,
	WHITE_LIGHT,
} from "./Material3DControls";

const EXTRUDE3D_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeDepth",
		paramKey: "depth",
		min: 1,
		max: 500,
		step: 1,
		defaultValue: 20,
	},
	{
		labelKey: "filterPanel.perspective",
		paramKey: "perspective",
		min: 0,
		max: 179,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
];

/** Virtual slider params mapped onto `bevel.size`. */
const BEVEL_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeBevelSize",
		paramKey: "bevelSize",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
	},
];

export const Extrude3DFilterControls = memo(function Extrude3DFilterControls({
	filter,
	onUpdate,
}: {
	filter: Extrude3DAppearance;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);

	const params = filter.paramData.params;
	const material = params.material;
	const bevelSize = params.bevel?.size ?? 0;

	const rotationParams = {
		rotateX: params.rotationDeg[0],
		rotateY: params.rotationDeg[1],
		rotateZ: params.rotationDeg[2],
	};

	const lightAzimuthDeg = azimuthDegOf(material.lightDir);
	const lightElevationDeg = elevationDegOf(material.lightDir);
	const lightParams = {
		lightAzimuth: lightAzimuthDeg,
		lightElevation: lightElevationDeg,
		specularPower: material.specularPower ?? 32,
	};
	const bevelParams = {
		bevelSize,
	};

	const pbrParams = {
		roughness: material.roughness ?? 0.5,
		metalness: material.metalness ?? 0,
		reflectivity: material.reflectivity ?? 0,
		glass: material.glass ?? 0,
	};
	const glassParams = {
		refraction: material.refraction ?? 1,
		thickness: material.thickness ?? 10,
		aberration: material.aberration ?? 0,
		blur: material.blur ?? 0,
	};
	const fresnelEnabled = material.fresnelEnabled === true;
	const fresnelParams = {
		fresnelBias: material.fresnelBias ?? 0,
		fresnelScale: material.fresnelScale ?? 1,
		fresnelIntensity: material.fresnelIntensity ?? 1,
		fresnelFactor: material.fresnelFactor ?? 5,
	};

	const shadingItems = useMemo(
		() => [
			{ label: t("filterPanel.extrudeShadingFlat"), value: "flat" },
			{ label: t("filterPanel.extrudeShadingLambert"), value: "lambert" },
			{
				label: t("filterPanel.extrudeShadingBlinnPhong"),
				value: "blinn-phong",
			},
		],
		[t],
	);

	const handleRotationSliderUpdate = useEventCallback(
		(p: Record<string, unknown>) => {
			const next: Vec3 = [
				"rotateX" in p ? (p.rotateX as number) : params.rotationDeg[0],
				"rotateY" in p ? (p.rotateY as number) : params.rotationDeg[1],
				"rotateZ" in p ? (p.rotateZ as number) : params.rotationDeg[2],
			];
			handleUpdate({ rotationDeg: next });
		},
	);

	const handleShadingChange = useEventCallback((value: string) => {
		handleUpdate({
			material: { ...material, shading: value as Material3D["shading"] },
		});
	});

	const handleLightColorChange = useEventCallback((color: Color) => {
		handleUpdate({ material: { ...material, lightColor: color } });
	});

	const handleShadowColorChange = useEventCallback((color: Color) => {
		handleUpdate({ material: { ...material, shadowColor: color } });
	});

	const handleLightSliderUpdate = useEventCallback(
		(p: Record<string, unknown>) => {
			if ("specularPower" in p) {
				handleUpdate({
					material: { ...material, specularPower: p.specularPower as number },
				});
				return;
			}
			const azimuthDeg =
				"lightAzimuth" in p ? (p.lightAzimuth as number) : lightAzimuthDeg;
			const elevationDeg =
				"lightElevation" in p
					? (p.lightElevation as number)
					: lightElevationDeg;
			handleUpdate({
				material: {
					...material,
					lightDir: lightDirFromAngles(azimuthDeg, elevationDeg),
				},
			});
		},
	);

	const handleBevelSliderUpdate = useEventCallback(
		(p: Record<string, unknown>) => {
			handleUpdate({
				bevel: {
					size: "bevelSize" in p ? (p.bevelSize as number) : bevelSize,
				},
			});
		},
	);

	// PBR + fresnel sliders write straight onto `material` (paramKey === field).
	const handleMaterialSliderUpdate = useEventCallback(
		(p: Record<string, unknown>) => {
			handleUpdate({ material: { ...material, ...p } });
		},
	);

	const handleFresnelToggle = useEventCallback((checked: boolean) => {
		handleUpdate({ material: { ...material, fresnelEnabled: checked } });
	});

	const handleFresnelColorChange = useEventCallback((color: Color) => {
		handleUpdate({ material: { ...material, fresnelColor: color } });
	});

	const handlePatternChange = useEventCallback((fill: FillColor | null) => {
		handleUpdate({
			material: {
				...material,
				pattern: fill?.type === "pattern" ? fill : null,
			},
		});
	});

	return (
		<Accordion.Root multiple defaultValue={[]}>
			<div className="space-y-0.5">
				<Section value="shape" label={t("filterPanel.extrudeGroupShape")}>
					<FilterSliders
						sliders={EXTRUDE3D_SLIDERS}
						params={params}
						onUpdate={onUpdate}
					/>
					<FilterSliders
						sliders={ROTATION_SLIDERS}
						params={rotationParams}
						onUpdate={handleRotationSliderUpdate}
					/>
					<FilterSliders
						sliders={BEVEL_SLIDERS}
						params={bevelParams}
						onUpdate={handleBevelSliderUpdate}
					/>
				</Section>

				<Section value="shading" label={t("filterPanel.extrudeGroupShading")}>
					<SimpleSelect
						$size="sm"
						items={shadingItems}
						value={material.shading}
						onValueChange={handleShadingChange}
					/>
					<FilterColorSwatch
						label={t("filterPanel.extrudeLightColor")}
						color={material.lightColor ?? WHITE_LIGHT}
						onColorChange={handleLightColorChange}
					/>
					<FilterColorSwatch
						label={t("filterPanel.extrudeShadowColor")}
						color={material.shadowColor ?? NEUTRAL_SHADOW}
						onColorChange={handleShadowColorChange}
					/>
					<FilterSliders
						sliders={
							material.shading === "blinn-phong"
								? LIGHT_AND_SPECULAR_SLIDERS
								: LIGHT_SLIDERS
						}
						params={lightParams}
						onUpdate={handleLightSliderUpdate}
					/>
				</Section>

				<Section value="material" label={t("filterPanel.extrudeMaterial")}>
					<FilterSliders
						sliders={PBR_SLIDERS}
						params={pbrParams}
						onUpdate={handleMaterialSliderUpdate}
					/>
					<MaterialPatternSwatch
						label={t("filterPanel.extrudeSurfaceTexture")}
						pattern={material.pattern ?? null}
						onPatternChange={handlePatternChange}
					/>
					{material.pattern?.defId ? (
						<FilterSliders
							sliders={SURFACE_TEXTURE_SLIDERS}
							params={{ patternOpacity: material.patternOpacity ?? 1 }}
							onUpdate={handleMaterialSliderUpdate}
						/>
					) : null}
				</Section>

				<Section value="glass" label={t("filterPanel.extrudeGroupGlass")}>
					<FilterSliders
						sliders={GLASS_SLIDERS}
						params={glassParams}
						onUpdate={handleMaterialSliderUpdate}
					/>
				</Section>

				<Section
					value="fresnel"
					label={t("filterPanel.extrudeFresnel")}
					headerRight={
						<Checkbox
							checked={fresnelEnabled}
							onCheckedChange={handleFresnelToggle}
						/>
					}
				>
					{fresnelEnabled ? (
						<>
							<FilterColorSwatch
								label={t("filterPanel.extrudeFresnelColor")}
								color={material.fresnelColor ?? WHITE_LIGHT}
								onColorChange={handleFresnelColorChange}
							/>
							<FilterSliders
								sliders={FRESNEL_SLIDERS}
								params={fresnelParams}
								onUpdate={handleMaterialSliderUpdate}
							/>
						</>
					) : (
						<p className="text-[10px] text-muted-foreground px-1">
							{t("filterPanel.extrudeFresnelHint")}
						</p>
					)}
				</Section>
			</div>
		</Accordion.Root>
	);
});
