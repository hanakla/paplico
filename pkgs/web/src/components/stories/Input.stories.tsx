import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Input } from "../Input";

const sizes = ["xs", "sm", "md", "lg"] as const;

const meta = {
	title: "Components/Input",
	component: Input,
	args: {
		placeholder: "Type here...",
		$size: "md",
		disabled: false,
	},
	argTypes: {
		$size: {
			control: "inline-radio",
			options: ["xs", "sm", "md", "lg"],
		},
		unit: {
			control: "text",
		},
	},
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {
		unit: "",
	},

	render: () => (
		<div className="grid gap-3 md:grid-cols-2">
			{sizes.map((size) => (
				<div
					key={size}
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">{size}</p>
					<Input $size={size} placeholder={`${size} size`} />
					<Input $size={size} placeholder="0" unit="px" />
					<Input $size={size} placeholder="disabled" disabled />
				</div>
			))}
		</div>
	),
};
