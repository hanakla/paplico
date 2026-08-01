import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { Drawer } from "../Drawer";

const drawerVariants = [
	{
		id: "right",
		label: "Side (right)",
		mode: "side" as const,
		side: "right" as const,
		swipeDirection: "right" as const,
	},
	{
		id: "left",
		label: "Side (left)",
		mode: "side" as const,
		side: "left" as const,
		swipeDirection: "left" as const,
	},
	{
		id: "bottom",
		label: "Bottom",
		mode: "bottom" as const,
		side: "right" as const,
		swipeDirection: "down" as const,
	},
];

const meta = {
	title: "Components/Drawer",
	component: Drawer.Root,
} satisfies Meta<typeof Drawer.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

function DrawerShowcase() {
	const [openId, setOpenId] = useState<string | null>(null);

	return (
		<div className="grid gap-3 md:grid-cols-3">
			{drawerVariants.map((variant) => (
				<div
					key={variant.id}
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">{variant.label}</p>
					<button
						type="button"
						className="rounded border border-border bg-background px-3 py-2 text-sm"
						onClick={() => setOpenId(variant.id)}
					>
						Open drawer
					</button>
					<Drawer.Root
						open={openId === variant.id}
						swipeDirection={variant.swipeDirection}
						onOpenChange={(open) => setOpenId(open ? variant.id : null)}
					>
						<Drawer.Content mode={variant.mode} side={variant.side}>
							<div className="flex flex-1 flex-col gap-3 p-4">
								<h3 className="text-sm font-medium">{variant.label} drawer</h3>
								<p className="text-xs text-muted-foreground">
									Panel content goes here.
								</p>
								<Drawer.Close className="mt-auto self-start rounded border border-border px-3 py-1.5 text-sm">
									Close
								</Drawer.Close>
							</div>
						</Drawer.Content>
					</Drawer.Root>
				</div>
			))}
		</div>
	);
}

export const Playground: Story = {
	args: {} as any,
	render: () => <DrawerShowcase />,
};
