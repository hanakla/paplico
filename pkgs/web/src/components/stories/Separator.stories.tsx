import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Separator } from "../Separator";

const meta = {
	title: "Components/Separator",
	component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;

type Story = StoryObj<typeof meta>;

function SeparatorShowcase() {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">horizontal</p>
				<div className="space-y-3 text-sm text-foreground">
					<p>Section one</p>
					<Separator orientation="horizontal" />
					<p>Section two</p>
				</div>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">vertical</p>
				<div className="flex h-16 items-center gap-3 text-sm text-foreground">
					<p>Left</p>
					<Separator orientation="vertical" />
					<p>Right</p>
				</div>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <SeparatorShowcase />,
};
