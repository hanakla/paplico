import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Switch } from "../Switch";

const meta = {
	title: "Components/Switch",
	component: Switch,
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

function SwitchShowcase() {
	const [checked, setChecked] = useState(false);
	const [labeled, setLabeled] = useState(true);

	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">{`controlled (${checked})`}</p>
				<Switch checked={checked} onCheckedChange={setChecked} />
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">with label</p>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex cursor-pointer items-center gap-2 text-sm">
					<Switch checked={labeled} onCheckedChange={setLabeled} />
					Enable feature
				</label>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled unchecked</p>
				<Switch checked={false} disabled />
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled checked</p>
				<Switch checked disabled />
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <SwitchShowcase />,
};
