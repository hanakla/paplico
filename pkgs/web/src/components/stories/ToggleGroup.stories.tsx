import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
	AlignCenter,
	AlignLeft,
	AlignRight,
	Bold,
	Italic,
	Underline,
} from "lucide-react";
import { useState } from "react";
import { ToggleGroup } from "../ToggleGroup";

const meta = {
	title: "Components/ToggleGroup",
	component: ToggleGroup.Root,
} satisfies Meta<typeof ToggleGroup.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

function ToggleGroupShowcase() {
	const [formatting, setFormatting] = useState<string[]>(["bold"]);
	const [align, setAlign] = useState<string[]>(["left"]);

	return (
		<div className="grid gap-3 md:grid-cols-3">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">formatting</p>
				<ToggleGroup.Root value={formatting} onValueChange={setFormatting}>
					<ToggleGroup.Item value="bold" aria-label="Bold">
						<Bold size={14} />
					</ToggleGroup.Item>
					<ToggleGroup.Item value="italic" aria-label="Italic">
						<Italic size={14} />
					</ToggleGroup.Item>
					<ToggleGroup.Item value="underline" aria-label="Underline">
						<Underline size={14} />
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">alignment</p>
				<ToggleGroup.Root value={align} onValueChange={setAlign}>
					<ToggleGroup.Item value="left" aria-label="Align left">
						<AlignLeft size={14} />
					</ToggleGroup.Item>
					<ToggleGroup.Item value="center" aria-label="Align center">
						<AlignCenter size={14} />
					</ToggleGroup.Item>
					<ToggleGroup.Item value="right" aria-label="Align right">
						<AlignRight size={14} />
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled</p>
				<ToggleGroup.Root value={["bold"]} disabled>
					<ToggleGroup.Item value="bold" aria-label="Bold">
						<Bold size={14} />
					</ToggleGroup.Item>
					<ToggleGroup.Item value="italic" aria-label="Italic">
						<Italic size={14} />
					</ToggleGroup.Item>
					<ToggleGroup.Item value="underline" aria-label="Underline">
						<Underline size={14} />
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <ToggleGroupShowcase />,
};
