import type { ShapeOption } from "@paplico/core/tools";
import { RotateCcw, RotateCw } from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { ToggleGroup } from "@/components/ToggleGroup";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { BrushFields } from "./BrushFields";
import { BrushStrokingFields } from "./BrushStrokingFields";
import { NumberRow } from "./NumberRow";

const MIN_VERTEX_COUNT = 3;

/** Stroke and parameters of the shape the shape tool draws next. */
export const ShapeToolControls = memo(function ShapeToolControls() {
	const { tools } = usePaplico();
	const toolSnap = useSnapshot(tools.state);

	const handleShapeChange = useEventCallback((shape: ShapeOption) => {
		tools.setShapeOption(shape);
	});

	return (
		<div className="flex flex-col gap-2 w-full">
			<BrushFields />
			<BrushStrokingFields />
			<ShapeParameterFields
				shape={toolSnap.shapeOption}
				onChange={handleShapeChange}
			/>
		</div>
	);
});

function ShapeParameterFields({
	shape,
	onChange,
}: {
	shape: ShapeOption;
	onChange: (shape: ShapeOption) => void;
}) {
	const t = useTranslation();

	switch (shape.type) {
		case "polygon":
			return (
				<NumberRow
					label={t("actionsPanel.polygonSides")}
					min={MIN_VERTEX_COUNT}
					max={20}
					step={1}
					value={shape.sides}
					onChange={(v) =>
						onChange({
							...shape,
							sides: Math.max(MIN_VERTEX_COUNT, Math.round(v)),
						})
					}
				/>
			);
		case "star":
			return (
				<>
					<NumberRow
						label={t("actionsPanel.starPoints")}
						min={MIN_VERTEX_COUNT}
						max={20}
						step={1}
						value={shape.points}
						onChange={(v) =>
							onChange({
								...shape,
								points: Math.max(MIN_VERTEX_COUNT, Math.round(v)),
							})
						}
					/>
					<NumberRow
						label={t("actionsPanel.starDepth")}
						min={0}
						max={1}
						step={0.01}
						value={shape.depth}
						onChange={(v) =>
							onChange({ ...shape, depth: Math.min(1, Math.max(0, v)) })
						}
					/>
				</>
			);
		case "spiral":
			return (
				<>
					<NumberRow
						label={t("actionsPanel.spiralTurns")}
						min={1}
						max={10}
						step={1}
						value={shape.turns}
						onChange={(v) =>
							onChange({ ...shape, turns: Math.max(1, Math.round(v)) })
						}
					/>
					<div className="flex flex-col gap-1">
						<span className="text-[10px] text-muted-foreground">
							{t("actionsPanel.spiralDirection")}
						</span>
						<ToggleGroup.Root
							value={[String(shape.direction)]}
							onValueChange={(value) => {
								if (value.length === 0) return;
								onChange({ ...shape, direction: value[0] === "1" ? 1 : -1 });
							}}
						>
							<Tooltip content={t("actionsPanel.spiralClockwise")}>
								<ToggleGroup.Item value="1" className="h-5 w-auto px-1.5">
									<RotateCw size={12} />
								</ToggleGroup.Item>
							</Tooltip>
							<Tooltip content={t("actionsPanel.spiralCounterclockwise")}>
								<ToggleGroup.Item value="-1" className="h-5 w-auto px-1.5">
									<RotateCcw size={12} />
								</ToggleGroup.Item>
							</Tooltip>
						</ToggleGroup.Root>
					</div>
				</>
			);
		case "ellipse":
		case "line":
			return (
				<span className="text-xs/none text-muted-foreground">
					{t("actionsPanel.shapeNoSettings")}
				</span>
			);
	}
}
