import type { Popover as BUIPopover } from "@base-ui/react/popover";
import type { ComponentProps, ReactNode } from "react";
import { ColorSwatch } from "@/components/ColorSwatch";
import { GradientPicker } from "@/components/GradientPicker";
import { Popover } from "@/components/Popover";
import type { StrokeGradientMode } from "@/core/schema";
import { useActiveColors } from "@/hooks/useActiveColors";
import { useTranslation } from "@/locales";
import { setActiveColorTarget, useUIState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

const STROKE_GRADIENT_MODES: StrokeGradientMode[] = [
	"within",
	"along",
	"across",
];

/**
 * Labeled fill/stroke swatch pair with popover pickers, backed by the
 * active selection (falls back to tool colors when nothing is selected).
 * The two swatches are laid out side by side (row by default; pass
 * `flex-col` via className for a vertical stack) so it is always visible
 * which one is being edited.
 */
export function FillStrokeSwatchPicker({
	className,
	popoverSide = "right",
	popoverSideOffset = 12,
	popoverAlign = "start",
	popoverPositionMethod,
	popoverContentWrapperProps,
}: {
	className?: string;
	popoverSide?: BUIPopover.Positioner.Props["side"];
	popoverSideOffset?: BUIPopover.Positioner.Props["sideOffset"];
	popoverAlign?: BUIPopover.Positioner.Props["align"];
	popoverPositionMethod?: BUIPopover.Positioner.Props["positionMethod"];
	popoverContentWrapperProps?: ComponentProps<"div"> & {
		[key: `data-${string}`]: string | undefined;
	};
}) {
	const t = useTranslation();
	const uiSnap = useUIState();
	const {
		currentFill,
		currentStrokeFill,
		currentStrokeGradientMode,
		hasMixedFillColor,
		hasMixedStrokeColor,
		handleGradientFillChange,
		handleStrokeGradientChange,
		handleStrokeGradientModeChange,
	} = useActiveColors();

	const handleFillSwatchClick = useEventCallback(() => {
		setActiveColorTarget("fill");
	});
	const handleStrokeSwatchClick = useEventCallback(() => {
		setActiveColorTarget("stroke");
	});

	return (
		<div className={twm("flex gap-1.5", className)}>
			{/* Fill color picker */}
			<Popover.Root>
				<Popover.Trigger>
					<SwatchButton
						label={t("toolbar.fillLabel")}
						isActive={uiSnap.activeColorTarget === "fill"}
						onClick={handleFillSwatchClick}
					>
						<ColorSwatch
							color={currentFill}
							variant="fill"
							size={24}
							className="w-full h-full rounded-none"
						/>
						{hasMixedFillColor && currentFill && <MixedColorBadge />}
					</SwatchButton>
				</Popover.Trigger>
				<Popover.Content
					side={popoverSide}
					sideOffset={popoverSideOffset}
					align={popoverAlign}
					positionMethod={popoverPositionMethod}
				>
					<div {...popoverContentWrapperProps}>
						<GradientPicker
							fill={currentFill}
							onFillChange={handleGradientFillChange}
						/>
					</div>
				</Popover.Content>
			</Popover.Root>

			{/* Stroke color/gradient picker */}
			<Popover.Root>
				<Popover.Trigger>
					<SwatchButton
						label={t("toolbar.strokeLabel")}
						isActive={uiSnap.activeColorTarget === "stroke"}
						onClick={handleStrokeSwatchClick}
					>
						<ColorSwatch
							color={currentStrokeFill}
							variant="stroke"
							size={24}
							className="w-full h-full rounded-none"
						/>
						{hasMixedStrokeColor && currentStrokeFill && <MixedColorBadge />}
					</SwatchButton>
				</Popover.Trigger>
				<Popover.Content
					side={popoverSide}
					sideOffset={popoverSideOffset}
					align={popoverAlign}
					positionMethod={popoverPositionMethod}
				>
					<div
						{...popoverContentWrapperProps}
						className={twm(
							"flex flex-col gap-3",
							popoverContentWrapperProps?.className,
						)}
					>
						<GradientPicker
							fill={currentStrokeFill}
							onFillChange={handleStrokeGradientChange}
							allowedTypes={["none", "solid", "linear"]}
						/>

						{/* Stroke gradient mode selector */}
						{currentStrokeFill?.type === "linear" && (
							<div className="flex flex-col gap-1.5">
								<span className="text-xs text-muted-foreground">
									{t("toolbar.strokeGradientMode")}
								</span>
								<div className="flex gap-1">
									{STROKE_GRADIENT_MODES.map((mode) => (
										<StrokeGradientModeButton
											key={mode}
											mode={mode}
											label={
												{
													within: t("toolbar.strokeGradientWithin"),
													along: t("toolbar.strokeGradientAlong"),
													across: t("toolbar.strokeGradientAcross"),
												}[mode]
											}
											isActive={currentStrokeGradientMode === mode}
											onSelect={handleStrokeGradientModeChange}
										/>
									))}
								</div>
							</div>
						)}
					</div>
				</Popover.Content>
			</Popover.Root>
		</div>
	);
}

function SwatchButton({
	label,
	isActive,
	onClick,
	children,
}: {
	label: string;
	isActive: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className="flex flex-col items-center gap-0.5 cursor-pointer"
			onClick={onClick}
		>
			<span
				className={`relative block w-6 h-6 rounded-sm border-2 overflow-hidden ${
					isActive ? "border-blue-500" : "border-border"
				}`}
			>
				{children}
			</span>
			<span
				className={`text-[9px] leading-none ${
					isActive ? "text-foreground" : "text-muted-foreground"
				}`}
			>
				{label}
			</span>
		</button>
	);
}

function MixedColorBadge() {
	return (
		<span className="absolute inset-0 flex items-center justify-center bg-black/20">
			<span className="text-white text-xs font-bold">?</span>
		</span>
	);
}

function StrokeGradientModeButton({
	mode,
	label,
	isActive,
	onSelect,
}: {
	mode: StrokeGradientMode;
	label: string;
	isActive: boolean;
	onSelect: (mode: StrokeGradientMode) => void;
}) {
	const handleClick = useEventCallback(() => {
		onSelect(mode);
	});

	return (
		<button
			type="button"
			className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
				isActive
					? "bg-accent text-accent-foreground"
					: "bg-muted text-muted-foreground hover:bg-muted/80"
			}`}
			onClick={handleClick}
		>
			{label}
		</button>
	);
}
