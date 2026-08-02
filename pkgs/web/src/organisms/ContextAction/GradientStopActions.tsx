import { CircleMinus } from "lucide-react";
import { useSnapshot } from "valtio";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { ColorSwatch } from "@/components/ColorSwatch";
import { IconButton } from "@/components/IconButton";
import { Popover } from "@/components/Popover";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useGradientStopColor } from "@/hooks/paplico/useGradientStopColor";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Stop-scoped actions of the gradient tool. The color swatch works for any
 * selected stop (linear/radial/free/mesh); delete only for the mesh family,
 * matching the tool's own delete support.
 */
export function GradientStopActions() {
	const t = useTranslation();
	const paplico = usePaplico();
	const toolSnap = useSnapshot(paplico.tools.state);
	const {
		fill,
		stopColor: gradientStopColor,
		setStopColor: setGradientStopColor,
	} = useGradientStopColor();

	const gradientStopId = toolSnap.gradientSelectedStopId;
	const gradientStopIndex = toolSnap.gradientSelectedStopIndex;
	const hasGradientStopSelected = gradientStopColor != null;
	const meshVertexIndex = gradientStopId?.startsWith("mesh-vertex:")
		? Number.parseInt(gradientStopId.split(":")[1], 10)
		: null;
	// Mirror the delete command's guards: linear/radial gradients keep at
	// least two stops, free gradients keep at least one, mesh gradients keep
	// their four corner vertices.
	const canDeleteGradientStop =
		hasGradientStopSelected &&
		(fill?.type === "free"
			? fill.stops.length > 1
			: fill?.type === "linear" || fill?.type === "radial"
				? gradientStopIndex != null && fill.stops.length > 2
				: meshVertexIndex != null && meshVertexIndex >= 4);

	const handleDeleteGradientStop = useEventCallback(() => {
		paplico.gradientDeleteSelectedStop();
	});

	return (
		<>
			<Popover.Root>
				<Tooltip content={t("contextActions.gradientStopColor")} side="bottom">
					<Popover.Trigger>
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							disabled={!hasGradientStopSelected}
						>
							<ColorSwatch
								color={
									gradientStopColor
										? { type: "solid", color: gradientStopColor }
										: null
								}
								variant="fill"
								size={20}
							/>
						</IconButton>
					</Popover.Trigger>
				</Tooltip>
				<Popover.Content side="top" sideOffset={12} positionMethod="absolute">
					<div data-context-actions-popover>
						{gradientStopColor && (
							<ColorPickerThin
								color={gradientStopColor}
								onColorChange={setGradientStopColor}
							/>
						)}
					</div>
				</Popover.Content>
			</Popover.Root>
			<Tooltip content={t("contextActions.gradientDeleteStop")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-danger"
					disabled={!canDeleteGradientStop}
					onClick={handleDeleteGradientStop}
				>
					<CircleMinus size={18} />
				</IconButton>
			</Tooltip>
			<Separator orientation="vertical" className="mx-0.5 h-5" />
		</>
	);
}
