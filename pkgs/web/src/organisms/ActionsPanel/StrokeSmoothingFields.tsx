import { useSnapshot } from "valtio";
import { ToggleGroup } from "@/components/ToggleGroup";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { StrokeWidthField } from "./StrokeWidthField";

/** How a freehand stroke is smoothed: the pen tool and sculpt mode share it. */
export function StrokeSmoothingFields() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const toolSnap = useSnapshot(tools.state);

	const handleStabilizationChange = useEventCallback((value: number) => {
		tools.setStabilization(value);
	});

	const handleSmoothingMethodChange = useEventCallback((value: string[]) => {
		if (value.length > 0) {
			tools.setSmoothingMethod(
				value[0] as "smooth" | "pulled-string" | "inertia",
			);
		}
	});

	return (
		<>
			<StrokeWidthField
				label={t("actionsPanel.stabilization")}
				value={toolSnap.stabilization}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleStabilizationChange}
			/>
			<div className="flex flex-col gap-1">
				<span className="type-label text-muted-foreground">
					{t("actionsPanel.smoothingMethod")}
				</span>
				<ToggleGroup.Root
					className="w-full"
					value={[toolSnap.smoothingMethod]}
					onValueChange={handleSmoothingMethodChange}
				>
					<ToggleGroup.Item
						value="smooth"
						className="h-5 w-auto flex-1 px-1.5 type-value"
					>
						{t("actionsPanel.smoothingSmooth")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="pulled-string"
						className="h-5 w-auto flex-1 px-1.5 type-value"
					>
						{t("actionsPanel.smoothingPulledString")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="inertia"
						className="h-5 w-auto flex-1 px-1.5 type-value"
					>
						{t("actionsPanel.smoothingInertia")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>
		</>
	);
}
