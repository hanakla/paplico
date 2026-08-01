import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Check, FilePlus2, FolderOpen, Save } from "lucide-react";
import { Menubar } from "../Menubar";

const meta = {
	title: "Components/Menubar",
	component: Menubar.Root,
} satisfies Meta<typeof Menubar.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {} as any,
	render: () => (
		<div className="space-y-3 rounded-md border border-border p-3">
			<p className="text-xs text-muted-foreground">
				Menus include shortcut, separator, and disabled states
			</p>
			<Menubar.Root className="rounded-md border border-border bg-background p-1">
				<Menubar.Menu trigger="File">
					<Menubar.Item shortcut="⌘N">
						<FilePlus2 size={14} />
						New
					</Menubar.Item>
					<Menubar.Item shortcut="⌘O">
						<FolderOpen size={14} />
						Open
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item shortcut="⌘S">
						<Save size={14} />
						Save
					</Menubar.Item>
					<Menubar.Item shortcut="⇧⌘S" disabled>
						Save as...
					</Menubar.Item>
				</Menubar.Menu>

				<Menubar.Menu trigger="Edit">
					<Menubar.Item shortcut="⌘Z">Undo</Menubar.Item>
					<Menubar.Item shortcut="⇧⌘Z">Redo</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item shortcut="⌘C">Copy</Menubar.Item>
					<Menubar.Item shortcut="⌘V">Paste</Menubar.Item>
				</Menubar.Menu>

				<Menubar.Menu trigger="View">
					<Menubar.Item shortcut="⌘1">
						<Check size={14} />
						Show grid
					</Menubar.Item>
					<Menubar.Item shortcut="⌘2">Snap to pixel</Menubar.Item>
				</Menubar.Menu>
			</Menubar.Root>
		</div>
	),
};
