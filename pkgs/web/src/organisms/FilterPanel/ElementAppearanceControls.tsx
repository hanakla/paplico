import { memo } from "react";
import { FakeInput } from "@/components/FakeInput";
import { Separator } from "@/components/Separator";
import { SimpleSelect } from "@/components/SimpleSelect";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { AnyArtObject, BlendMode, CompositionMode } from "@/core/schema";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { useCompositionModeItems } from "@/hooks/useCompositionModeItems";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { ElementMaskControls } from "./ElementMaskControls";

export const ElementAppearanceControls = memo(
	function ElementAppearanceControls({
		element,
		layerId,
	}: {
		element: AnyArtObject;
		layerId: string;
	}) {
		const { commands } = usePaplico();
		const t = useTranslation();
		const blendModeItems = useBlendModeItems();
		const compositionModeItems = useCompositionModeItems();

		const handleOpacityChange = useEventCallback((value: number) => {
			commands.updateElement(layerId, element.id, { opacity: value / 100 });
		});

		const handleBlendModeChange = useEventCallback((value: string) => {
			commands.updateElement(layerId, element.id, {
				blendMode: value as BlendMode,
			});
		});

		const handleCompositionModeChange = useEventCallback((value: string) => {
			commands.updateElement(layerId, element.id, {
				compositionMode: value as CompositionMode,
			});
		});

		const handleStopPropagation = useEventCallback((e: React.PointerEvent) => {
			e.stopPropagation();
		});

		const opacityPercent = Math.round(element.opacity * 100);

		return (
			<div className="space-y-2" onPointerDown={handleStopPropagation}>
				<div className="flex items-center justify-between text-muted-foreground text-xs">
					<span>{t("filterPanel.opacity")}</span>
					<FakeInput
						type="number"
						step={0.1}
						unit="%"
						$behaviour="click"
						$side="end"
						$size="xs"
						value={`${opacityPercent}`}
						onChange={(val) => {
							if (val == null) return;
							const parsed = Number.parseFloat(val.trim());
							if (Number.isNaN(parsed)) return;
							handleOpacityChange(Math.min(100, Math.max(0, parsed)));
						}}
					/>
				</div>

				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.blendMode")}
					</div>
					<SimpleSelect
						$size="sm"
						items={blendModeItems}
						value={element.blendMode}
						onValueChange={handleBlendModeChange}
					/>
				</div>

				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.compositionMode")}
					</div>
					<SimpleSelect
						$size="sm"
						items={compositionModeItems}
						value={element.compositionMode ?? "normal"}
						onValueChange={handleCompositionModeChange}
					/>
				</div>

				<Separator />

				<ElementMaskControls element={element} />
			</div>
		);
	},
);
