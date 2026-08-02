import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { SimpleSelect } from "../SimpleSelect";

const options = [
	{ label: "Left", value: "left" },
	{ label: "Center", value: "center" },
	{ label: "Right", value: "right" },
];
const sizes = ["sm", "md", "lg"] as const;

const meta = {
	title: "Components/SimpleSelect",
	component: SimpleSelect,
	args: {
		label: "Align",
		$size: "md",
		disabled: false,
	},
	argTypes: {
		$size: {
			control: "inline-radio",
			options: ["sm", "md", "lg"],
		},
	},
} satisfies Meta<typeof SimpleSelect>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {} as any,
	render: () => {
		const [values, setValues] = useState<Record<string, string>>({
			sm: options[0]?.value ?? "",
			md: options[0]?.value ?? "",
			lg: options[0]?.value ?? "",
		});

		return (
			<div className="flex flex-wrap gap-3">
				{sizes.map((size) => (
					<div
						key={size}
						className="w-[22rem] rounded-md border border-border p-3"
					>
						<p className="mb-2 text-xs text-muted-foreground">{size}</p>
						<SimpleSelect<string, false>
							items={options}
							value={values[size]}
							onValueChange={(next) =>
								setValues((prev) => ({
									...prev,
									[size]: next ?? "",
								}))
							}
							label="Align"
							$size={size}
						/>
					</div>
				))}
			</div>
		);
	},
};
