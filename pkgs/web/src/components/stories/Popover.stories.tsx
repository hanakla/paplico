import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Popover } from "../Popover";

const sideVariants = ["top", "right", "bottom", "left"] as const;

const meta = {
	title: "Components/Popover",
	component: Popover.Root,
} satisfies Meta<typeof Popover.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {} as any,
	render: () => (
		<div className="grid gap-3 md:grid-cols-2">
			{sideVariants.map((side) => (
				<div
					key={side}
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">{`side = ${side}`}</p>
					<Popover.Root>
						<Popover.Trigger>
							<button
								type="button"
								className="rounded border border-border bg-background px-3 py-2 text-sm"
							>
								Open popover
							</button>
						</Popover.Trigger>
						<Popover.Content side={side}>
							<div className="w-56 space-y-1">
								<p className="text-sm font-medium">Popover content</p>
								<p className="text-xs text-muted-foreground">
									This card previews arrow direction and popup animation.
								</p>
							</div>
						</Popover.Content>
					</Popover.Root>
				</div>
			))}
		</div>
	),
};
