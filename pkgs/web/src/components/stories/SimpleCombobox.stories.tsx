import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { SimpleCombobox } from "../SimpleCombobox";

type Item = { label: string; value: string };
type SeparatorItem = { separator: true; id: string };

// Mirrors the ICC-profile picker usage in ExportDialog/DocumentSettingsDialog,
// where a separator item groups builtin options from embedded ones.
const fontItems: (Item | SeparatorItem)[] = [
	{ label: "Inter", value: "inter" },
	{ label: "Noto Sans JP", value: "noto-sans-jp" },
	{ label: "JetBrains Mono", value: "jetbrains-mono" },
	{ separator: true, id: "sep-embedded" },
	{ label: "IBM Plex Sans", value: "ibm-plex-sans" },
];

const meta = {
	title: "Components/SimpleCombobox",
	component: SimpleCombobox,
	args: {
		items: [],
		value: "",
		onValueChange: () => {},
	},
} satisfies Meta<typeof SimpleCombobox>;

export default meta;

type Story = StoryObj<typeof meta>;

function SimpleComboboxShowcase() {
	const [md, setMd] = useState("inter");
	const [sm, setSm] = useState("noto-sans-jp");

	return (
		<div className="grid gap-3 md:grid-cols-3">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">md (default)</p>
				<SimpleCombobox
					items={fontItems}
					value={md}
					onValueChange={setMd}
					placeholder="Select a font"
				/>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">sm</p>
				<SimpleCombobox
					items={fontItems}
					value={sm}
					onValueChange={setSm}
					placeholder="Select a font"
					$size="sm"
				/>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled</p>
				<SimpleCombobox
					items={fontItems}
					value={md}
					onValueChange={setMd}
					placeholder="Select a font"
					disabled
				/>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <SimpleComboboxShowcase />,
};
