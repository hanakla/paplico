import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Combobox } from "../Combobox";

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
	title: "Components/Combobox",
	component: Combobox.Root,
} satisfies Meta<typeof Combobox.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: () => {
		const [value, setValue] = useState<Option | null>(options[0] ?? null);

		return (
			<div className="grid gap-3 md:grid-cols-2">
				<div className="rounded-md border border-border p-3">
					<p className="mb-2 text-xs text-muted-foreground">default</p>
					<Combobox.Root<Option>
						items={options}
						value={value}
						onValueChange={setValue}
						itemToStringLabel={(item) => item?.label ?? ""}
						filter={(item, query) =>
							item.label.toLowerCase().includes(query.toLowerCase())
						}
					>
						<div className="relative">
							<Combobox.Input placeholder="Select a font" />
							<div className="absolute right-2 bottom-0 flex h-10 items-center gap-2">
								<Combobox.Clear />
								<Combobox.Trigger />
							</div>
						</div>

						<Combobox.Portal>
							<Combobox.Positioner>
								<Combobox.Popup>
									<Combobox.Empty>No match</Combobox.Empty>
									<Combobox.List<Option>>
										{(item) => (
											<Combobox.Item key={`default-${item.value}`} value={item}>
												<Combobox.ItemIndicator />
												<span className="col-start-2">{item.label}</span>
											</Combobox.Item>
										)}
									</Combobox.List>
								</Combobox.Popup>
							</Combobox.Positioner>
						</Combobox.Portal>
					</Combobox.Root>
				</div>

				<div className="rounded-md border border-border p-3">
					<p className="mb-2 text-xs text-muted-foreground">disabled</p>
					<Combobox.Root<Option>
						items={options}
						value={value}
						onValueChange={setValue}
						itemToStringLabel={(item) => item?.label ?? ""}
						disabled
					>
						<div className="relative">
							<Combobox.Input placeholder="Select a font" />
							<div className="absolute right-2 bottom-0 flex h-10 items-center gap-2">
								<Combobox.Clear />
								<Combobox.Trigger />
							</div>
						</div>
					</Combobox.Root>
				</div>
			</div>
		);
	},
};
