import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ContextMenu } from "../ContextMenu";

const meta = {
	title: "Components/ContextMenu",
	component: ContextMenu.Root,
} satisfies Meta<typeof ContextMenu.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

function ContextMenuShowcase() {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					Basic menu (right click inside area)
				</p>
				<ContextMenu.Root>
					<ContextMenu.Trigger>
						<div className="flex h-32 items-center justify-center rounded border border-dashed border-border bg-muted/20 text-sm">
							Right click here
						</div>
					</ContextMenu.Trigger>
					<ContextMenu.Portal>
						<ContextMenu.Positioner>
							<ContextMenu.Popup>
								<ContextMenu.Item>Copy</ContextMenu.Item>
								<ContextMenu.Item>Paste</ContextMenu.Item>
								<ContextMenu.Separator />
								<ContextMenu.Item disabled>Delete (disabled)</ContextMenu.Item>
							</ContextMenu.Popup>
						</ContextMenu.Positioner>
					</ContextMenu.Portal>
				</ContextMenu.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					Group + submenu (right click inside area)
				</p>
				<ContextMenu.Root>
					<ContextMenu.Trigger>
						<div className="flex h-32 items-center justify-center rounded border border-dashed border-border bg-muted/20 text-sm">
							Right click here
						</div>
					</ContextMenu.Trigger>
					<ContextMenu.Portal>
						<ContextMenu.Positioner>
							<ContextMenu.Popup>
								<ContextMenu.Group>
									<ContextMenu.GroupLabel>Align</ContextMenu.GroupLabel>
									<ContextMenu.Item>Left</ContextMenu.Item>
									<ContextMenu.Item>Center</ContextMenu.Item>
									<ContextMenu.Item>Right</ContextMenu.Item>
								</ContextMenu.Group>
								<ContextMenu.Separator />
								<ContextMenu.SubmenuRoot>
									<ContextMenu.SubmenuTrigger>
										Arrange
									</ContextMenu.SubmenuTrigger>
									<ContextMenu.Portal>
										<ContextMenu.Positioner sideOffset={8}>
											<ContextMenu.Popup>
												<ContextMenu.Item>Bring to front</ContextMenu.Item>
												<ContextMenu.Item>Send to back</ContextMenu.Item>
											</ContextMenu.Popup>
										</ContextMenu.Positioner>
									</ContextMenu.Portal>
								</ContextMenu.SubmenuRoot>
							</ContextMenu.Popup>
						</ContextMenu.Positioner>
					</ContextMenu.Portal>
				</ContextMenu.Root>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <ContextMenuShowcase />,
};
