import {
	Box,
	Circle,
	Cone,
	Cylinder,
	type LucideIcon,
	Square,
} from "lucide-react";
import { memo, useMemo } from "react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { IconButton } from "@/components/IconButton";
import { SimpleSelect } from "@/components/SimpleSelect";
import { InfiniteSlider, Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type {
	Reference3DCamera,
	Reference3DPrimitiveShape,
	Vec3,
} from "@/core/schema";
import {
	getCameraDistance,
	getCameraOrbitAngles,
	Reference3DTool,
} from "@/core/tools/Reference3DTool";
import { FileSystem } from "@/infra/filesystem";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

const PRIMITIVES: Array<{
	shape: Reference3DPrimitiveShape;
	icon: LucideIcon;
	labelKey: LocalizeKeys;
}> = [
	{ shape: "box", icon: Box, labelKey: "actionsPanel.reference3dBox" },
	{ shape: "sphere", icon: Circle, labelKey: "actionsPanel.reference3dSphere" },
	{
		shape: "cylinder",
		icon: Cylinder,
		labelKey: "actionsPanel.reference3dCylinder",
	},
	{ shape: "cone", icon: Cone, labelKey: "actionsPanel.reference3dCone" },
	{ shape: "plane", icon: Square, labelKey: "actionsPanel.reference3dPlane" },
];

/** Default light direction, mirrored from the service's shadow rig. */
const DEFAULT_LIGHT_DIR: Vec3 = [6, 10, 4];

export const Reference3DToolControls = memo(function Reference3DToolControls() {
	const t = useTranslation();
	const paplico = usePaplico();
	const snap = useSnapshot(paplico.uiState);

	const editingId = snap.reference3dEditingElementId;
	const element = editingId ? snap.document.objects[editingId] : null;
	const scene = element?.type === "reference3d" ? element : null;

	const lightDir = (scene?.lightDir ?? DEFAULT_LIGHT_DIR) as Vec3;
	const lightAzimuth = Math.round(azimuthDegOf(lightDir));
	const lightElevation = Math.round(elevationDegOf(lightDir));
	const includeInExport = scene?.includeInExport === true;

	const cameraDistance = scene
		? getCameraDistance(scene.camera as Reference3DCamera)
		: 0;
	const cameraOrbit = scene
		? getCameraOrbitAngles(scene.camera as Reference3DCamera)
		: { yawDeg: 0, pitchDeg: 0 };

	// Shared scenes are reusable across elements (one scene, many cameras) —
	// the select re-points this element at any existing scene.
	const references3d = snap.document.references3d;
	const sceneItems = useMemo(
		() =>
			Object.values(references3d ?? {}).map((def, index) => ({
				label: def.name ?? `${t("actionsPanel.reference3dScene")} ${index + 1}`,
				value: def.id,
			})),
		[references3d, t],
	);

	const handleAddPrimitive = useEventCallback(
		(shape: Reference3DPrimitiveShape) => {
			const tool = paplico.tools.getCurrentTool();
			if (tool instanceof Reference3DTool) tool.addPrimitive(shape);
		},
	);

	const handleAddModel = useEventCallback(async () => {
		// App-layer file access (core only ever receives the bytes).
		const handle = await FileSystem.openFileDialog({
			id: "reference3d-model",
			types: [
				{
					description: "3D Model (VRM / GLB)",
					accept: { "model/gltf-binary": [".vrm", ".glb"] },
				},
			],
		}).catch(() => null);
		if (!handle) return;

		const bytes = new Uint8Array(await handle.file.arrayBuffer());
		await paplico.reference3dAddModelFromBytes(bytes, handle.file.name);
	});

	const handleZoomChange = useEventCallback((distance: number) => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) tool.setCameraZoom(distance);
	});

	const handleYawChange = useEventCallback((yawDeg: number) => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) {
			tool.setCameraOrbit(yawDeg, cameraOrbit.pitchDeg);
		}
	});

	const handlePitchChange = useEventCallback((pitchDeg: number) => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) {
			tool.setCameraOrbit(cameraOrbit.yawDeg, pitchDeg);
		}
	});

	const handleMoveXChange = useEventCallback((delta: number) => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) tool.moveCameraAlongAxis("x", delta);
	});

	const handleMoveYChange = useEventCallback((delta: number) => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) tool.moveCameraAlongAxis("y", delta);
	});

	const handleMoveZChange = useEventCallback((delta: number) => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) tool.moveCameraAlongAxis("z", delta);
	});

	const handleMoveDragEnd = useEventCallback(() => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof Reference3DTool) tool.endCameraAxisMove();
	});

	const handleAzimuthChange = useEventCallback((deg: number) => {
		paplico.reference3dUpdateEditingElement({
			lightDir: lightDirFromAngles(deg, lightElevation),
		});
	});

	const handleElevationChange = useEventCallback((deg: number) => {
		paplico.reference3dUpdateEditingElement({
			lightDir: lightDirFromAngles(lightAzimuth, deg),
		});
	});

	const handleIncludeInExportChange = useEventCallback((checked: boolean) => {
		paplico.reference3dUpdateEditingElement({ includeInExport: checked });
	});

	const handleSceneChange = useEventCallback((sceneId: string) => {
		paplico.reference3dUpdateEditingElement({ sceneId });
	});

	if (!scene) {
		return (
			<p className="text-[10px] leading-tight text-muted-foreground px-1">
				{t("toolbar.reference3dHint")}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-3 w-full">
			{sceneItems.length > 1 && (
				<div className="flex flex-col">
					<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
						{t("actionsPanel.reference3dScene")}
					</span>
					<SimpleSelect
						$size="sm"
						items={sceneItems}
						value={scene.sceneId}
						onValueChange={handleSceneChange}
					/>
				</div>
			)}

			<div className="flex flex-col">
				<span className="mb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
					{t("actionsPanel.reference3dAddPrimitive")}
				</span>
				<div className="flex gap-1">
					{PRIMITIVES.map(({ shape, icon, labelKey }) => (
						<PrimitiveButton
							key={shape}
							shape={shape}
							icon={icon}
							label={t(labelKey)}
							onAdd={handleAddPrimitive}
						/>
					))}
				</div>
			</div>

			<Button $size="sm" $variant="default" onClick={handleAddModel}>
				{t("toolbar.reference3dAddModel")}
			</Button>

			<div className="flex flex-col">
				<span className="mb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
					{t("actionsPanel.reference3dCamera")}
				</span>
				<LabeledInfiniteSlider
					label={t("actionsPanel.reference3dCameraZoom")}
					value={cameraDistance}
					unit="m"
					range={2}
					step={0.1}
					onValueChange={handleZoomChange}
				/>
				<LabeledSlider
					label={t("actionsPanel.reference3dCameraYaw")}
					value={Math.round(cameraOrbit.yawDeg)}
					min={-180}
					max={180}
					unit="°"
					onValueChange={handleYawChange}
				/>
				<LabeledSlider
					label={t("actionsPanel.reference3dCameraPitch")}
					value={Math.round(cameraOrbit.pitchDeg)}
					min={-90}
					max={90}
					unit="°"
					onValueChange={handlePitchChange}
				/>
				<div className="flex flex-col gap-1">
					<span className="text-[10px] text-muted-foreground px-1">
						{t("actionsPanel.reference3dCameraMove")}
					</span>
					<MoveAxisSlider
						axisLabel="X"
						onValueChange={handleMoveXChange}
						onDragEnd={handleMoveDragEnd}
					/>
					<MoveAxisSlider
						axisLabel="Y"
						onValueChange={handleMoveYChange}
						onDragEnd={handleMoveDragEnd}
					/>
					<MoveAxisSlider
						axisLabel="Z"
						onValueChange={handleMoveZChange}
						onDragEnd={handleMoveDragEnd}
					/>
				</div>
			</div>

			<div className="flex flex-col">
				<span className="mb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
					{t("actionsPanel.reference3dLight")}
				</span>
				<LabeledSlider
					label={t("actionsPanel.reference3dLightAzimuth")}
					value={lightAzimuth}
					min={-180}
					max={180}
					unit="°"
					onValueChange={handleAzimuthChange}
				/>
				<LabeledSlider
					label={t("actionsPanel.reference3dLightElevation")}
					value={lightElevation}
					min={-90}
					max={90}
					unit="°"
					onValueChange={handleElevationChange}
				/>
			</div>

			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer px-1">
				<Checkbox
					checked={includeInExport}
					onCheckedChange={handleIncludeInExportChange}
				/>
				{t("actionsPanel.reference3dIncludeInExport")}
			</label>
		</div>
	);
});

function PrimitiveButton({
	shape,
	icon: Icon,
	label,
	onAdd,
}: {
	shape: Reference3DPrimitiveShape;
	icon: LucideIcon;
	label: string;
	onAdd: (shape: Reference3DPrimitiveShape) => void;
}) {
	const handleClick = useEventCallback(() => onAdd(shape));
	return (
		<Tooltip content={label} side="bottom">
			<IconButton $size="sm" $variant="ghost" onClick={handleClick}>
				<Icon size={16} />
			</IconButton>
		</Tooltip>
	);
}

function LabeledSlider({
	label,
	value,
	min,
	max,
	unit,
	onValueChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	unit: string;
	onValueChange: (value: number) => void;
}) {
	return (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-1">
				<span className="text-[10px] text-muted-foreground">{label}</span>
				<span className="text-[10px] text-foreground font-mono tabular-nums">
					{value}
					{unit}
				</span>
			</div>
			<Slider
				min={min}
				max={max}
				step={1}
				value={value}
				onValueChange={onValueChange}
			/>
		</div>
	);
}

/** Camera distance has no natural min/max, so it uses an unbounded InfiniteSlider. */
function LabeledInfiniteSlider({
	label,
	value,
	unit,
	range,
	step,
	onValueChange,
}: {
	label: string;
	value: number;
	unit: string;
	range: number;
	step: number;
	onValueChange: (value: number) => void;
}) {
	return (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-1">
				<span className="text-[10px] text-muted-foreground">{label}</span>
				<span className="text-[10px] text-foreground font-mono tabular-nums">
					{value.toFixed(1)}
					{unit}
				</span>
			</div>
			<InfiniteSlider
				min={-Infinity}
				max={Infinity}
				range={range}
				step={step}
				value={value}
				onValueChange={onValueChange}
			/>
		</div>
	);
}

/**
 * One axis of the camera-move control. Unlike LabeledInfiniteSlider, there's
 * no absolute position to display — `value` is pinned at 0 so each drag
 * reports its own delta from a fresh rest position (see moveCameraAlongAxis).
 */
function MoveAxisSlider({
	axisLabel,
	onValueChange,
	onDragEnd,
}: {
	axisLabel: string;
	onValueChange: (delta: number) => void;
	onDragEnd: () => void;
}) {
	return (
		<div className="flex items-center gap-2 px-1">
			<span className="text-[10px] text-muted-foreground w-3">{axisLabel}</span>
			<InfiniteSlider
				min={-Infinity}
				max={Infinity}
				range={0.5}
				step={0.01}
				value={0}
				onValueChange={onValueChange}
				onDragEnd={onDragEnd}
				className="flex-1"
			/>
		</div>
	);
}

const DEG_PER_RAD = 180 / Math.PI;

function azimuthDegOf(dir: Vec3): number {
	return Math.atan2(dir[0], dir[2]) * DEG_PER_RAD;
}

function elevationDegOf(dir: Vec3): number {
	const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
	return Math.asin(Math.min(1, Math.max(-1, dir[1] / len))) * DEG_PER_RAD;
}

function lightDirFromAngles(azimuthDeg: number, elevationDeg: number): Vec3 {
	const azimuth = azimuthDeg / DEG_PER_RAD;
	const elevation = elevationDeg / DEG_PER_RAD;
	// Keep a fixed magnitude so slider round-trips are stable.
	const r = 12;
	return [
		r * Math.cos(elevation) * Math.sin(azimuth),
		r * Math.sin(elevation),
		r * Math.cos(elevation) * Math.cos(azimuth),
	];
}
