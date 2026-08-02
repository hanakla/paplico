import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import type { Color } from "@/core/schema";
import {
	ColorPicker2,
	ColorPickerFull,
	ColorPickerThin,
} from "../ColorPicker2";

const initialRGBColor: Color = {
	type: "rgb",
	r: 0.2,
	g: 0.55,
	b: 0.95,
	a: 1,
};

const initialHSVColor: Color = {
	type: "hsv",
	h: 0.08,
	s: 0.9,
	v: 0.6,
	a: 0.8,
};

const initialFullColor: Color = {
	type: "rgb",
	r: 0.22,
	g: 0.8,
	b: 0.52,
	a: 1,
};

const meta = {
	title: "Components/ColorPicker",
	component: ColorPickerThin,
} satisfies Meta<typeof ColorPickerThin>;

export default meta;

type Story = StoryObj<typeof meta>;

function ColorPickerShowcase() {
	const [thinColor, setThinColor] = useState<Color>(initialRGBColor);
	const [hsvColor, setHslColor] = useState<Color>(initialHSVColor);
	const [fullColor, setFullColor] = useState<Color>(initialFullColor);

	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					ColorPickerThin / RGBA mode (mode determined by color.type)
				</p>
				<ColorPickerThin color={thinColor} onColorChange={setThinColor} />
				<p className="text-[10px] text-muted-foreground/60">
					output type: {thinColor.type}
				</p>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					ColorPickerThin / HSVA mode (mode determined by color.type)
				</p>
				<ColorPickerThin color={hsvColor} onColorChange={setHslColor} />
				<p className="text-[10px] text-muted-foreground/60">
					output type: {hsvColor.type}
				</p>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					ColorPickerFull / mode switching via toggle button
				</p>
				<ColorPickerFull
					color={fullColor}
					onColorChange={setFullColor}
					saturationHeight="h-32"
				/>
				<p className="text-[10px] text-muted-foreground/60">
					output type: {fullColor.type}
				</p>
			</div>
		</div>
	);
}

function CompoundShowcase() {
	const [color, setColor] = useState<Color>(initialRGBColor);

	return (
		<div className="w-64 rounded-lg border border-border bg-popover p-3">
			<ColorPicker2.Root color={color} onColorChange={setColor}>
				<ColorPicker2.Saturation className="h-40" />
				<div className="flex items-center gap-3 py-3">
					<ColorPicker2.EyeDropper />
					<div className="flex flex-1 flex-col gap-2">
						<ColorPicker2.Hue />
						<ColorPicker2.Alpha />
					</div>
				</div>
				<div className="flex items-center gap-2 pb-2">
					<ColorPicker2.Swatch className="size-8" />
					<ColorPicker2.HexInput />
				</div>
				<ColorPicker2.ChannelInputs />
			</ColorPicker2.Root>
			<p className="mt-2 text-[10px] text-muted-foreground/60">
				output type: {color.type}
			</p>
		</div>
	);
}

export const Playground: Story = {
	args: {} as any,
	render: () => <ColorPickerShowcase />,
};

export const CompoundComponents: Story = {
	args: {} as any,
	render: () => <CompoundShowcase />,
};
