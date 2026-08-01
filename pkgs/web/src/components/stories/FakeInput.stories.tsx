import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { FakeInput } from "../FakeInput";

const sizes = ["xs", "sm", "md", "lg"] as const;

const meta = {
	title: "Components/FakeInput",
	component: FakeInput,
	args: {
		value: "Layer 1",
		placeholder: "Unnamed",
		$size: "sm",
		onChange: () => {},
	},
	argTypes: {
		$size: {
			control: "inline-radio",
			options: ["xs", "sm", "md", "lg"],
		},
		$behaviour: {
			control: "inline-radio",
			options: ["default", "click"],
		},
		$side: {
			control: "inline-radio",
			options: ["start", "end"],
		},
		type: {
			control: "inline-radio",
			options: ["text", "number"],
		},
		unit: {
			control: "text",
		},
	},
} satisfies Meta<typeof FakeInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: () => (
		<div className="grid gap-3 md:grid-cols-2">
			{sizes.map((size) => (
				<div
					key={size}
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">{size}</p>
					<FakeInput $size={size} value="Named item" onChange={() => {}} />
					<FakeInput $size={size} value="42.5" unit="px" onChange={() => {}} />
				</div>
			))}
		</div>
	),
};

function InteractiveDemo(props: FakeInput.Props) {
	const [value, setValue] = useState<string | undefined>("My Element");

	return (
		<div className="space-y-2 w-64">
			<FakeInput
				{...props}
				value={value}
				placeholder="Unnamed element"
				onChange={setValue}
			/>
			<p className="text-xs text-muted-foreground">
				Current value: {value ?? "(undefined)"}
			</p>
		</div>
	);
}

export const Interactive: Story = {
	render: (args) => <InteractiveDemo {...args} />,
};

function NumericWithUnitDemo(props: FakeInput.Props) {
	const [value, setValue] = useState<string | undefined>("42.5");

	return (
		<div className="space-y-2 w-64">
			<FakeInput
				{...props}
				type="number"
				step={0.1}
				unit="px"
				$behaviour="click"
				$side="end"
				value={value}
				placeholder="0"
				onChange={setValue}
			/>
			<p className="text-xs text-muted-foreground">
				Current value: {value ?? "(undefined)"}
			</p>
		</div>
	);
}

export const NumericWithUnit: Story = {
	render: (args) => <NumericWithUnitDemo {...args} />,
};

function ClickBehaviourDemo(props: FakeInput.Props) {
	const [value, setValue] = useState<string | undefined>("42.5");

	return (
		<div className="space-y-2 w-64">
			<FakeInput
				{...props}
				$behaviour="click"
				value={value}
				placeholder="Click to edit"
				onChange={setValue}
			/>
			<p className="text-xs text-muted-foreground">
				Current value: {value ?? "(undefined)"}
			</p>
		</div>
	);
}

export const ClickBehaviour: Story = {
	render: (args) => <ClickBehaviourDemo {...args} />,
};
