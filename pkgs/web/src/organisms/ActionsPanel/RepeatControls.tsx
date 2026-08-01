import { Unlink } from "lucide-react";
import { memo, useId } from "react";
import { useSnapshot } from "valtio";
import { Checkbox } from "@/components/Checkbox";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoCommands, usePaplicoStore } from "@/contexts/PaplicoContext";
import { isRepeat, type RepeatMode } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Repeat parameter controls in the ActionsPanel. Shown when a single Repeat is
 * selected; mirrors the gizmo, so both edit the same `updateRepeat*` commands.
 */
export const RepeatControls = memo(function RepeatControls() {
	const t = useTranslation();
	const commands = usePaplicoCommands();
	const store = usePaplicoStore();
	const snap = useSnapshot(store);
	const rotateInstancesId = useId();

	const selected = snap.selectedElementIds
		.map((id) => snap.document.objects[id])
		.filter((el) => el !== undefined);
	const repeats = selected.filter(isRepeat);
	const repeat =
		selected.length === 1 && repeats.length === 1 ? repeats[0] : null;

	const handleModeChange = useEventCallback((mode: string) => {
		if (!repeat) return;
		commands.setRepeatMode(repeat.id, mode as RepeatMode);
	});

	const handleRelease = useEventCallback(() => {
		if (!repeat) return;
		commands.releaseRepeat(repeat.id);
	});

	const handleGrid = useEventCallback(
		(
			field:
				| "width"
				| "height"
				| "spacingX"
				| "spacingY"
				| "offsetX"
				| "offsetY",
			value: number,
		) => {
			if (!repeat) return;
			commands.updateRepeatGrid(repeat.id, { [field]: value });
		},
	);

	const handleRadial = useEventCallback(
		(field: "count" | "radius" | "startAngle" | "sweep", value: number) => {
			if (!repeat) return;
			commands.updateRepeatRadial(repeat.id, { [field]: value });
		},
	);

	const handleRotateInstances = useEventCallback((checked: boolean) => {
		if (!repeat) return;
		commands.updateRepeatRadial(repeat.id, { rotateInstances: checked });
	});

	const handleMirror = useEventCallback(
		(field: "axisAngle" | "offset", value: number) => {
			if (!repeat) return;
			commands.updateRepeatMirror(repeat.id, { [field]: value });
		},
	);

	if (!repeat) return null;

	return (
		<div className="flex flex-col gap-1.5 w-full">
			<div className="flex items-center justify-between px-1">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
					{t("actionsPanel.repeat")}
				</span>
				<Tooltip content={t("actionsPanel.releaseRepeat")} side="bottom">
					<IconButton $size="xs" $variant="ghost" onClick={handleRelease}>
						<Unlink size={14} />
					</IconButton>
				</Tooltip>
			</div>
			<div className="flex flex-col gap-1.5 px-1">
				<SimpleSelect
					$size="sm"
					items={[
						{ label: t("actionsPanel.repeatModeGrid"), value: "grid" },
						{ label: t("actionsPanel.repeatModeRadial"), value: "radial" },
						{ label: t("actionsPanel.repeatModeMirror"), value: "mirror" },
					]}
					value={repeat.mode}
					onValueChange={handleModeChange}
				/>

				{repeat.mode === "grid" && (
					<>
						<NumberRow
							label={t("actionsPanel.repeatWidth")}
							min={0}
							max={4000}
							step={1}
							value={repeat.grid.width}
							onChange={(v) => handleGrid("width", Math.max(0, v))}
						/>
						<NumberRow
							label={t("actionsPanel.repeatHeight")}
							min={0}
							max={4000}
							step={1}
							value={repeat.grid.height}
							onChange={(v) => handleGrid("height", Math.max(0, v))}
						/>
						<NumberRow
							label={t("actionsPanel.repeatSpacingX")}
							min={1}
							max={1000}
							step={1}
							value={repeat.grid.spacingX}
							onChange={(v) => handleGrid("spacingX", Math.max(1, v))}
						/>
						<NumberRow
							label={t("actionsPanel.repeatSpacingY")}
							min={1}
							max={1000}
							step={1}
							value={repeat.grid.spacingY}
							onChange={(v) => handleGrid("spacingY", Math.max(1, v))}
						/>
						<NumberRow
							label={t("actionsPanel.repeatOffsetX")}
							min={-1000}
							max={1000}
							step={1}
							value={repeat.grid.offsetX ?? 0}
							onChange={(v) => handleGrid("offsetX", v)}
						/>
						<NumberRow
							label={t("actionsPanel.repeatOffsetY")}
							min={-1000}
							max={1000}
							step={1}
							value={repeat.grid.offsetY ?? 0}
							onChange={(v) => handleGrid("offsetY", v)}
						/>
					</>
				)}

				{repeat.mode === "radial" && (
					<>
						<NumberRow
							label={t("actionsPanel.repeatCount")}
							min={1}
							max={100}
							step={1}
							value={repeat.radial.count}
							onChange={(v) =>
								handleRadial("count", Math.max(1, Math.round(v)))
							}
						/>
						<NumberRow
							label={t("actionsPanel.repeatRadius")}
							min={1}
							max={1000}
							step={1}
							value={repeat.radial.radius}
							onChange={(v) => handleRadial("radius", Math.max(1, v))}
						/>
						<NumberRow
							label={t("actionsPanel.repeatStartAngle")}
							min={-180}
							max={180}
							step={1}
							value={Math.round(repeat.radial.startAngle * RAD_TO_DEG)}
							onChange={(v) => handleRadial("startAngle", v * DEG_TO_RAD)}
						/>
						<NumberRow
							label={t("actionsPanel.repeatSweep")}
							min={0}
							max={360}
							step={1}
							value={Math.round(repeat.radial.sweep * RAD_TO_DEG)}
							onChange={(v) => handleRadial("sweep", v * DEG_TO_RAD)}
						/>
						<label
							htmlFor={rotateInstancesId}
							className="flex items-center gap-2 text-[10px] text-muted-foreground cursor-pointer select-none"
						>
							<Checkbox
								id={rotateInstancesId}
								checked={repeat.radial.rotateInstances}
								onCheckedChange={handleRotateInstances}
							/>
							{t("actionsPanel.repeatRotateInstances")}
						</label>
					</>
				)}

				{repeat.mode === "mirror" && (
					<>
						<NumberRow
							label={t("actionsPanel.repeatAxisAngle")}
							min={-180}
							max={180}
							step={1}
							value={Math.round(repeat.mirror.axisAngle * RAD_TO_DEG)}
							onChange={(v) => handleMirror("axisAngle", v * DEG_TO_RAD)}
						/>
						<NumberRow
							label={t("actionsPanel.repeatOffset")}
							min={-1000}
							max={1000}
							step={1}
							value={repeat.mirror.offset}
							onChange={(v) => handleMirror("offset", v)}
						/>
					</>
				)}
			</div>
		</div>
	);
});

// --- Helpers ---

function NumberRow({
	label,
	min,
	max,
	step,
	value,
	onChange,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-[10px] text-muted-foreground shrink-0 w-12">
				{label}
			</span>
			<Slider
				min={min}
				max={max}
				step={step}
				value={value}
				onValueChange={onChange}
				className="flex-1"
			/>
			<FakeInput
				$size="xs"
				type="number"
				step={step}
				min={min}
				max={max}
				value={String(value)}
				onChange={(v) => onChange(v ? Number(v) : min)}
				className="w-12 text-right tabular-nums"
			/>
		</div>
	);
}
