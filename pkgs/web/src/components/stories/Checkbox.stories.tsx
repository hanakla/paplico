import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Minus } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "../Checkbox";

const meta = {
	title: "Components/Checkbox",
	component: Checkbox,
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

function CheckboxShowcase() {
	const [checked, setChecked] = useState(false);
	const [labeled, setLabeled] = useState(true);

	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">{`controlled (${checked})`}</p>
				<Checkbox checked={checked} onCheckedChange={setChecked} />
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">with label</p>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex cursor-pointer items-center gap-2 text-sm">
					<Checkbox checked={labeled} onCheckedChange={setLabeled} />
					Accept terms
				</label>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">indeterminate</p>
				<Checkbox indeterminate />
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">custom indicator</p>
				<Checkbox checked>
					<Minus size={10} strokeWidth={3} />
				</Checkbox>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled unchecked</p>
				<Checkbox checked={false} disabled />
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled checked</p>
				<Checkbox checked disabled />
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <CheckboxShowcase />,
};
