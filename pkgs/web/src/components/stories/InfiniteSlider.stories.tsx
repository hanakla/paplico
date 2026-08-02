import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { InfiniteSlider } from "../Slider";

const meta = {
	title: "Components/InfiniteSlider",
	component: InfiniteSlider,
	args: {
		value: 0,
		min: -100,
		max: 100,
		range: 50,
		step: 1,
		onValueChange: () => {},
	},
} satisfies Meta<typeof InfiniteSlider>;

export default meta;

type Story = StoryObj<typeof meta>;

function InfiniteSliderShowcase() {
	const [bounded, setBounded] = useState(0);
	const [unbounded, setUnbounded] = useState(0);
	const [halfBounded, setHalfBounded] = useState(20);

	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">{`bounded -100..100 (${bounded})`}</p>
				<InfiniteSlider
					value={bounded}
					onValueChange={setBounded}
					min={-100}
					max={100}
					range={50}
					step={1}
				/>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">{`unbounded (${unbounded})`}</p>
				<InfiniteSlider
					value={unbounded}
					onValueChange={setUnbounded}
					min={-Infinity}
					max={Infinity}
					range={50}
					step={1}
				/>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3 md:col-span-2">
				<p className="text-xs text-muted-foreground">{`half-bounded 0.. (${halfBounded})`}</p>
				<InfiniteSlider
					value={halfBounded}
					onValueChange={setHalfBounded}
					min={0}
					max={Infinity}
					range={50}
					step={1}
				/>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <InfiniteSliderShowcase />,
};
