import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Select } from "../Select";

const options = [
	{ label: "Linear", value: "linear" },
	{ label: "Multiply", value: "multiply" },
	{ label: "Screen", value: "screen" },
	{ label: "Overlay", value: "overlay" },
];
const sizes = ["sm", "md", "lg"] as const;

const meta = {
	title: "Components/Select",
	component: Select.Root,
} satisfies Meta<typeof Select.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: () => {
		const [values, setValues] = useState<Record<string, string>>({
			sm: options[0]?.value ?? "",
			md: options[0]?.value ?? "",
			lg: options[0]?.value ?? "",
		});

		return (
			<div className="grid gap-3 md:grid-cols-3">
				{sizes.map((size) => (
					<div key={size} className="rounded-md border border-border p-3">
						<p className="mb-2 text-xs text-muted-foreground">{size}</p>
						<Select.Root
							value={values[size]}
							onValueChange={(next: string) =>
								setValues((prev) => ({ ...prev, [size]: next }))
							}
							items={options}
						>
							<Select.Trigger $size={size}>
								<Select.Value placeholder="Select..." />
								<Select.Icon />
							</Select.Trigger>

							<Select.Portal>
								<Select.Positioner>
									<Select.Popup>
										{options.map((item) => (
											<Select.Item
												key={`${size}-${item.value}`}
												value={item.value}
											>
												<Select.ItemIndicator />
												<Select.ItemText className="col-start-2">
													{item.label}
												</Select.ItemText>
											</Select.Item>
										))}
									</Select.Popup>
								</Select.Positioner>
							</Select.Portal>
						</Select.Root>
					</div>
				))}
			</div>
		);
	},
};
