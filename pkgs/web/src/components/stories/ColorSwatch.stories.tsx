import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { FillColor, RGBColor, StrokeColor } from "@/core/schema";
import { ColorSwatch } from "../ColorSwatch";

const rgb = (r: number, g: number, b: number, a = 1): RGBColor => ({
	type: "rgb",
	r,
	g,
	b,
	a,
});

const SOLID_FILL: FillColor = { type: "solid", color: rgb(0.95, 0.3, 0.35) };

const fillSamples: Array<{ label: string; color: FillColor | null }> = [
	{ label: "solid", color: SOLID_FILL },
	{
		label: "linear",
		color: {
			type: "linear",
			x1: 0,
			y1: 0.5,
			x2: 1,
			y2: 0.5,
			stops: [
				{ offset: 0, color: rgb(0.9, 0.2, 0.3), midpoint: 0.5 },
				{ offset: 1, color: rgb(1, 0.95, 0.3), midpoint: 0.5 },
			],
		},
	},
	{
		label: "radial",
		color: {
			type: "radial",
			cx: 0.5,
			cy: 0.5,
			radiusX: 0.5,
			radiusY: 0.5,
			rotation: 0,
			stops: [
				{ offset: 0, color: rgb(0.3, 0.7, 0.95), midpoint: 0.5 },
				{ offset: 1, color: rgb(0.1, 0.18, 0.45), midpoint: 0.5 },
			],
		},
	},
	{
		label: "free",
		color: {
			type: "free",
			stops: [
				{ id: "s1", x: 0.2, y: 0.2, color: rgb(1, 0.2, 0.2) },
				{ id: "s2", x: 0.8, y: 0.8, color: rgb(0.2, 0.4, 1) },
			],
		},
	},
	{
		label: "pattern",
		color: {
			type: "pattern",
			defId: null,
			scaleX: 1,
			scaleY: 1,
			rotation: 0,
			offsetX: 0,
			offsetY: 0,
		},
	},
	{ label: "empty", color: null },
];

const strokeSamples: Array<{ label: string; color: StrokeColor | null }> = [
	{ label: "solid", color: { type: "solid", color: rgb(0.2, 0.5, 0.9) } },
	{
		label: "stroke-gradient",
		color: {
			type: "stroke-gradient",
			mode: "within",
			gradient: {
				type: "linear",
				x1: 0,
				y1: 0.5,
				x2: 1,
				y2: 0.5,
				stops: [
					{ offset: 0, color: rgb(0.95, 0.5, 0.1), midpoint: 0.5 },
					{ offset: 1, color: rgb(0.95, 0.85, 0.2), midpoint: 0.5 },
				],
			},
		},
	},
	{
		label: "stroke-pattern",
		color: {
			type: "stroke-pattern",
			mode: "within",
			pattern: {
				type: "pattern",
				defId: null,
				scaleX: 1,
				scaleY: 1,
				rotation: 0,
				offsetX: 0,
				offsetY: 0,
			},
		},
	},
	{ label: "empty", color: null },
];

const meta = {
	title: "Components/ColorSwatch",
	component: ColorSwatch,
} satisfies Meta<typeof ColorSwatch>;

export default meta;

type Story = StoryObj<typeof meta>;

function ColorSwatchShowcase() {
	return (
		<div className="space-y-4">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">variant="fill"</p>
				<div className="flex flex-wrap gap-4">
					{fillSamples.map((sample) => (
						<div
							key={sample.label}
							className="flex flex-col items-center gap-1"
						>
							<ColorSwatch color={sample.color} variant="fill" size={32} />
							<span className="text-[10px] text-muted-foreground">
								{sample.label}
							</span>
						</div>
					))}
				</div>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">variant="stroke"</p>
				<div className="flex flex-wrap gap-4">
					{strokeSamples.map((sample) => (
						<div
							key={sample.label}
							className="flex flex-col items-center gap-1"
						>
							<ColorSwatch color={sample.color} variant="stroke" size={32} />
							<span className="text-[10px] text-muted-foreground">
								{sample.label}
							</span>
						</div>
					))}
				</div>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">sizes (solid fill)</p>
				<div className="flex items-end gap-3">
					{[10, 14, 20, 32, 48].map((size) => (
						<ColorSwatch
							key={size}
							color={SOLID_FILL}
							variant="fill"
							size={size}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

export const Playground: Story = {
	args: {} as any,
	render: () => <ColorSwatchShowcase />,
};
