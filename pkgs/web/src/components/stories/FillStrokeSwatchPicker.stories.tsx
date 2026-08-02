import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import type { FillColor, RGBColor, StrokeGradientMode } from "@/core/schema";
import { useTranslation } from "@/locales";
import { ColorSwatch } from "../ColorSwatch";
import { FillStrokeSwatchPicker } from "../FillStrokeSwatchPicker";
import { GradientPicker } from "../GradientPicker";
import { Popover } from "../Popover";

const STROKE_GRADIENT_MODES: StrokeGradientMode[] = [
	"within",
	"along",
	"across",
];

const rgb = (r: number, g: number, b: number, a = 1): RGBColor => ({
	type: "rgb",
	r,
	g,
	b,
	a,
});

const meta = {
	title: "Components/FillStrokeSwatchPicker",
	component: FillStrokeSwatchPicker,
} satisfies Meta<typeof FillStrokeSwatchPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * FillStrokeSwatchPicker reads/writes colors through useActiveColors(),
 * which requires a live Paplico engine via PaplicoContext (usePaplico(),
 * throws without a provider). Storybook has no engine instance, so this
 * showcase reproduces the same overlapping fill/stroke swatch + popover
 * interaction with local state, built from the same pieces the real
 * component composes (ColorSwatch, Popover, GradientPicker).
 */
function FillStrokeSwatchPickerShowcase() {
	const t = useTranslation();
	const [fill, setFill] = useState<FillColor | null>({
		type: "solid",
		color: rgb(0.2, 0.5, 0.95),
	});
	const [strokeFill, setStrokeFill] = useState<FillColor | null>({
		type: "solid",
		color: rgb(0.1, 0.1, 0.1),
	});
	const [strokeGradientMode, setStrokeGradientMode] =
		useState<StrokeGradientMode>("within");
	const [activeTarget, setActiveTarget] = useState<"fill" | "stroke">("fill");

	return (
		<div className="relative w-6 h-6">
			<Popover.Root>
				<Popover.Trigger>
					<button
						type="button"
						className={`absolute top-0 left-0 w-6 h-6 rounded-sm border-2 overflow-hidden cursor-pointer ${
							activeTarget === "fill"
								? "border-blue-500 z-10"
								: "border-border z-0"
						}`}
						onClick={() => setActiveTarget("fill")}
					>
						<ColorSwatch
							color={fill}
							variant="fill"
							size={24}
							className="w-full h-full rounded-none"
						/>
					</button>
				</Popover.Trigger>
				<Popover.Content side="right" sideOffset={12} align="start">
					<GradientPicker fill={fill} onFillChange={setFill} />
				</Popover.Content>
			</Popover.Root>

			<Popover.Root>
				<Popover.Trigger>
					<button
						type="button"
						className={`absolute bottom-0 right-0 w-6 h-6 rounded-sm overflow-hidden cursor-pointer ${
							activeTarget === "stroke"
								? "ring-1 ring-inset ring-white z-10"
								: "ring-1 ring-inset ring-border z-0"
						}`}
						onClick={() => setActiveTarget("stroke")}
					>
						<ColorSwatch
							color={strokeFill}
							variant="stroke"
							size={24}
							className="w-full h-full rounded-none"
						/>
					</button>
				</Popover.Trigger>
				<Popover.Content side="right" sideOffset={12} align="start">
					<div className="flex flex-col gap-3">
						<GradientPicker
							fill={strokeFill}
							onFillChange={setStrokeFill}
							allowedTypes={["none", "solid", "linear"]}
						/>

						{strokeFill?.type === "linear" && (
							<div className="flex flex-col gap-1.5">
								<span className="text-xs text-muted-foreground">
									{t("toolbar.strokeGradientMode")}
								</span>
								<div className="flex gap-1">
									{STROKE_GRADIENT_MODES.map((mode) => (
										<button
											key={mode}
											type="button"
											className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
												strokeGradientMode === mode
													? "bg-accent text-accent-foreground"
													: "bg-muted text-muted-foreground hover:bg-muted/80"
											}`}
											onClick={() => setStrokeGradientMode(mode)}
										>
											{
												{
													within: t("toolbar.strokeGradientWithin"),
													along: t("toolbar.strokeGradientAlong"),
													across: t("toolbar.strokeGradientAcross"),
												}[mode]
											}
										</button>
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

export const Playground: Story = {
	render: () => (
		<div className="p-6">
			<FillStrokeSwatchPickerShowcase />
		</div>
	),
};
