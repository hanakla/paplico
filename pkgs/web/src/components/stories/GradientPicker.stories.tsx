import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import type { FillColor, RGBColor } from "@/core/schema";
import { GradientPicker } from "../GradientPicker";

type AllowedType = "none" | "solid" | "linear" | "radial" | "free";

const rgb = (r: number, g: number, b: number, a = 1): RGBColor => ({
	type: "rgb",
	r,
	g,
	b,
	a,
});

const initialFills: Record<string, FillColor | null> = {
	none: null,
	solid: {
		type: "solid",
		color: rgb(0.18, 0.42, 0.95),
	},
	linear: {
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
	radial: {
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
	free: {
		type: "free",
		stops: [
			{ id: "s1", x: 0.2, y: 0.2, color: rgb(1, 0.2, 0.2) },
			{ id: "s2", x: 0.8, y: 0.2, color: rgb(0.95, 0.95, 0.2) },
			{ id: "s3", x: 0.8, y: 0.8, color: rgb(0.2, 0.9, 0.4) },
			{ id: "s4", x: 0.2, y: 0.8, color: rgb(0.2, 0.4, 1) },
		],
	},
};

const cards: Array<{
	id: keyof typeof initialFills;
	label: string;
	allowedTypes?: AllowedType[];
}> = [
	{ id: "none", label: "fill = null (all types)" },
	{ id: "solid", label: "fill = solid", allowedTypes: ["none", "solid"] },
	{
		id: "linear",
		label: "fill = linear",
		allowedTypes: ["none", "linear", "radial"],
	},
	{
		id: "radial",
		label: "fill = radial",
		allowedTypes: ["none", "linear", "radial"],
	},
	{ id: "free", label: "fill = free", allowedTypes: ["none", "free"] },
];

const meta = {
	title: "Components/GradientPicker",
	component: GradientPicker,
} satisfies Meta<typeof GradientPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

function GradientPickerShowcase() {
	const [fills, setFills] =
		useState<Record<string, FillColor | null>>(initialFills);

	return (
		<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{cards.map((card) => (
				<div
					key={card.id}
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">{card.label}</p>
					<GradientPicker
						fill={fills[card.id]}
						onFillChange={(next) =>
							setFills((prev) => ({ ...prev, [card.id]: next }))
						}
						allowedTypes={card.allowedTypes}
					/>
				</div>
			))}
		</div>
	);
}

export const Playground: Story = {
	args: {} as any,
	render: () => <GradientPickerShowcase />,
};
