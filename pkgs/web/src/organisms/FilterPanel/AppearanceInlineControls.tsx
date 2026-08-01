import { Grid2x2 } from "lucide-react";
import { memo } from "react";
import { FakeInput } from "@/components/FakeInput";
import { FakeSelect } from "@/components/FakeSelect";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type {
	AnyArtObject,
	BlendMode,
	CompositionMode,
	Filter,
} from "@/core/schema";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Compact opacity / blend mode (/ composition mode) controls embedded
 * directly in an appearance-panel row. Pointer and click events are stopped
 * so interacting with the controls neither toggles the row's selection
 * popover nor starts a sortable drag.
 */
export const AppearanceInlineControls = memo(function AppearanceInlineControls({
	opacity,
	blendMode,
	compositionMode,
	onOpacityChange,
	onBlendModeChange,
	onCompositionModeChange,
}: {
	/** 0..1 */
	opacity: number;
	blendMode: BlendMode;
	/** Omit to hide the alpha-lock toggle (fill/stroke/content rows). */
	compositionMode?: CompositionMode;
	/** Receives the clamped opacity as 0..1. */
	onOpacityChange: (opacity: number) => void;
	onBlendModeChange: (blendMode: BlendMode) => void;
	onCompositionModeChange?: (mode: CompositionMode) => void;
}) {
	const t = useTranslation();
	const blendModeItems = useBlendModeItems();

	// dnd-kit's MouseSensor/TouchSensor activate on mousedown/touchstart, so
	// those must be stopped alongside pointer/click events.
	const handleStop = useEventCallback((e: React.SyntheticEvent) => {
		e.stopPropagation();
	});

	const handleOpacityInput = useEventCallback((val: string | undefined) => {
		if (val == null) return;
		const parsed = Number.parseFloat(val.trim());
		if (Number.isNaN(parsed)) return;
		onOpacityChange(Math.min(100, Math.max(0, parsed)) / 100);
	});

	const handleBlendModeChange = useEventCallback((value: string) => {
		onBlendModeChange(value as BlendMode);
	});

	const handleCompositionToggle = useEventCallback(() => {
		onCompositionModeChange?.(
			compositionMode === "alpha-lock" ? "normal" : "alpha-lock",
		);
	});

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click handler only stops propagation
		// biome-ignore lint/a11y/noStaticElementInteractions: click handler only stops propagation
		<div
			className="flex h-6 items-center gap-2"
			onPointerDown={handleStop}
			onMouseDown={handleStop}
			onTouchStart={handleStop}
			onClick={handleStop}
		>
			<FakeInput
				type="number"
				step={1}
				min={0}
				max={100}
				unit="%"
				$side="end"
				$size="sm"
				value={`${Math.round(opacity * 100)}`}
				onChange={handleOpacityInput}
			/>
			<FakeSelect
				$size="sm"
				className="min-w-0"
				items={blendModeItems}
				value={blendMode}
				onValueChange={handleBlendModeChange}
			/>
			{compositionMode !== undefined && (
				<Tooltip
					content={`${t("filterPanel.compositionMode")}: ${t(
						compositionMode === "alpha-lock"
							? "filterPanel.compositionModes.alpha-lock"
							: "filterPanel.compositionModes.normal",
					)}`}
				>
					<IconButton
						$size="xs"
						$variant="ghost"
						$pressed={compositionMode === "alpha-lock"}
						aria-label={t("filterPanel.compositionMode")}
						onClick={handleCompositionToggle}
					>
						<Grid2x2 size={12} />
					</IconButton>
				</Tooltip>
			)}
		</div>
	);
});

/** Inline controls for a fill / stroke / content appearance row. */
export const FilterInlineControls = memo(function FilterInlineControls({
	filter,
	index,
}: {
	filter: Filter;
	index: number;
}) {
	const { commands } = usePaplico();

	const handleOpacityChange = useEventCallback((opacity: number) => {
		commands.updateFilterForSelectedElement(index, { opacity });
	});

	const handleBlendModeChange = useEventCallback((blendMode: BlendMode) => {
		commands.updateFilterForSelectedElement(index, { blendMode });
	});

	return (
		<AppearanceInlineControls
			opacity={filter.opacity}
			blendMode={filter.blendMode}
			onOpacityChange={handleOpacityChange}
			onBlendModeChange={handleBlendModeChange}
		/>
	);
});

/** Inline controls for the element (object) header row. */
export const ElementInlineControls = memo(function ElementInlineControls({
	element,
	layerId,
}: {
	element: AnyArtObject;
	layerId: string;
}) {
	const { commands } = usePaplico();

	const handleOpacityChange = useEventCallback((opacity: number) => {
		commands.updateElement(layerId, element.id, { opacity });
	});

	const handleBlendModeChange = useEventCallback((blendMode: BlendMode) => {
		commands.updateElement(layerId, element.id, { blendMode });
	});

	const handleCompositionModeChange = useEventCallback(
		(compositionMode: CompositionMode) => {
			commands.updateElement(layerId, element.id, { compositionMode });
		},
	);

	return (
		<AppearanceInlineControls
			opacity={element.opacity}
			blendMode={element.blendMode}
			compositionMode={element.compositionMode ?? "normal"}
			onOpacityChange={handleOpacityChange}
			onBlendModeChange={handleBlendModeChange}
			onCompositionModeChange={handleCompositionModeChange}
		/>
	);
});
