import { memo, useMemo } from "react";
import { Accordion } from "@/components/Accordion";
import { Checkbox } from "@/components/Checkbox";
import { SimpleSelect } from "@/components/SimpleSelect";
import type {
	Color,
	FillColor,
	Material3D,
	Revolve3DAppearance,
	Revolve3DParams,
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

const REVOLVE3D_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.revolveAngle",
		paramKey: "angleDeg",
		min: 1,
		max: 360,
		step: 1,
		defaultValue: 360,
		unit: "°",
	},
	{
		labelKey: "filterPanel.revolveOffset",
		paramKey: "offset",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 0,
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

export const Revolve3DFilterControls = memo(function Revolve3DFilterControls({
	filter,
	onUpdate,
}: {
	filter: Revolve3DAppearance;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);

	const params = filter.paramData.params;
	const material = params.material;

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

	const axisItems = useMemo(
		() => [
			{ label: t("filterPanel.revolveAxisLeft"), value: "left" },
			{ label: t("filterPanel.revolveAxisRight"), value: "right" },
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

	const handleAxisChange = useEventCallback((value: string) => {
		handleUpdate({ axis: value as Revolve3DParams["axis"] });
	});

	const handleCapToggle = useEventCallback((checked: boolean) => {
		handleUpdate({ cap: checked });
	});

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
						sliders={REVOLVE3D_SLIDERS}
						params={params}
						onUpdate={onUpdate}
					/>
					<div className="flex items-center justify-between">
						<span className="text-muted-foreground text-xs">
							{t("filterPanel.revolveAxis")}
						</span>
						<SimpleSelect
							$size="sm"
							items={axisItems}
							value={params.axis}
							onValueChange={handleAxisChange}
						/>
					</div>
					<div className="flex items-center justify-between">
						<span className="text-muted-foreground text-xs">
							{t("filterPanel.revolveCap")}
						</span>
						<Checkbox checked={params.cap} onCheckedChange={handleCapToggle} />
					</div>
					<FilterSliders
						sliders={ROTATION_SLIDERS}
						params={rotationParams}
						onUpdate={handleRotationSliderUpdate}
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
