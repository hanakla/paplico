import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Combobox2 } from "../Combobox2";

type Option = {
	label: string;
	value: string;
};

const options: Option[] = [
	{ label: "Inter", value: "inter" },
	{ label: "Noto Sans JP", value: "noto-sans-jp" },
	{ label: "JetBrains Mono", value: "jetbrains-mono" },
	{ label: "IBM Plex Sans", value: "ibm-plex-sans" },
];

const meta = {
	title: "Components/Combobox2",
	component: Combobox2.Root,
} satisfies Meta<typeof Combobox2.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: () => {
		const [value, setValue] = useState<Option | null>(options[0] ?? null);

		return (
			<div className="grid gap-3 md:grid-cols-3">
				{(["sm", "md"] as const).map((size) => (
					<div key={size} className="rounded-md border border-border p-3">
						<p className="mb-2 text-xs text-muted-foreground">{size}</p>
						<Combobox2.Root<Option>
							items={options}
							value={value}
							onValueChange={setValue}
							itemToStringLabel={(item) => item?.label ?? ""}
							filter={(item, query) =>
								item.label.toLowerCase().includes(query.toLowerCase())
							}
						>
							<Combobox2.Input placeholder="Select a font" $size={size} />
							<Combobox2.Popup>
								<Combobox2.Empty>No match</Combobox2.Empty>
								<Combobox2.List<Option>>
									{(item) => (
										<Combobox2.Item
											key={`${size}-${item.value}`}
											value={item}
											$size={size}
										>
											{item.label}
										</Combobox2.Item>
									)}
								</Combobox2.List>
							</Combobox2.Popup>
						</Combobox2.Root>
					</div>
				))}

				<div className="rounded-md border border-border p-3">
					<p className="mb-2 text-xs text-muted-foreground">disabled</p>
					<Combobox2.Root<Option>
						items={options}
						value={value}
						onValueChange={setValue}
						itemToStringLabel={(item) => item?.label ?? ""}
						disabled
					>
						<Combobox2.Input placeholder="Select a font" $size="sm" />
					</Combobox2.Root>
				</div>
			</div>
		);
	},
};
