import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Slider } from "../Slider";

const meta = {
	title: "Components/Slider",
	component: Slider,
	args: {
		min: 0,
		max: 100,
		step: 1,
	},
} satisfies Meta<typeof Slider>;

export default meta;

type Story = StoryObj<typeof meta>;

function toNumber(value: number | readonly number[]) {
	return typeof value === "number" ? value : (value[0] ?? 0);
}

function SliderShowcase() {
	const [horizontal, setHorizontal] = useState(40);
	const [vertical, setVertical] = useState(65);
	const [fineStep, setFineStep] = useState(0.35);

	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">{`horizontal (${horizontal})`}</p>
				<Slider
					value={horizontal}
					onValueChange={(next) => setHorizontal(toNumber(next))}
					min={0}
					max={100}
					step={1}
				/>
				<Slider value={75} disabled min={0} max={100} step={1} />
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">{`vertical (${vertical})`}</p>
				<div className="h-44">
					<Slider
						orientation="vertical"
						value={vertical}
						onValueChange={(next) => setVertical(toNumber(next))}
						min={0}
						max={100}
						step={1}
					/>
				</div>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3 md:col-span-2">
				<p className="text-xs text-muted-foreground">{`fine step (${fineStep.toFixed(2)})`}</p>
				<Slider
					value={fineStep}
					onValueChange={(next) => setFineStep(toNumber(next))}
					min={0}
					max={1}
					step={0.01}
				/>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <SliderShowcase />,
};
