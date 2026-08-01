import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Check, Circle } from "lucide-react";
import { useState } from "react";
import { Menu } from "../Menu";

const meta = {
	title: "Components/Menu",
	component: Menu.Root,
} satisfies Meta<typeof Menu.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

function MenuShowcase() {
	const [showGrid, setShowGrid] = useState(true);
	const [showRulers, setShowRulers] = useState(false);
	const [zoom, setZoom] = useState("100");

	return (
		<div className="grid gap-3 md:grid-cols-3">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">Basic menu</p>
				<Menu.Root>
					<Menu.Trigger>File</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner sideOffset={4}>
							<Menu.Popup>
								<Menu.Item>New</Menu.Item>
								<Menu.Item>Open...</Menu.Item>
								<Menu.Separator />
								<Menu.Item disabled>Delete (disabled)</Menu.Item>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					Checkbox &amp; radio items
				</p>
				<Menu.Root>
					<Menu.Trigger>View</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner sideOffset={4}>
							<Menu.Popup>
								<Menu.CheckboxItem
									checked={showGrid}
									onCheckedChange={setShowGrid}
								>
									<Menu.CheckboxItemIndicator>
										<Check size={12} />
									</Menu.CheckboxItemIndicator>
									Show grid
								</Menu.CheckboxItem>
								<Menu.CheckboxItem
									checked={showRulers}
									onCheckedChange={setShowRulers}
								>
									<Menu.CheckboxItemIndicator>
										<Check size={12} />
									</Menu.CheckboxItemIndicator>
									Show rulers
								</Menu.CheckboxItem>
								<Menu.Separator />
								<Menu.GroupLabel>Zoom</Menu.GroupLabel>
								<Menu.RadioGroup value={zoom} onValueChange={setZoom}>
									<Menu.RadioItem value="50">
										<Menu.RadioItemIndicator>
											<Circle size={8} fill="currentColor" />
										</Menu.RadioItemIndicator>
										50%
									</Menu.RadioItem>
									<Menu.RadioItem value="100">
										<Menu.RadioItemIndicator>
											<Circle size={8} fill="currentColor" />
										</Menu.RadioItemIndicator>
										100%
									</Menu.RadioItem>
									<Menu.RadioItem value="200">
										<Menu.RadioItemIndicator>
											<Circle size={8} fill="currentColor" />
										</Menu.RadioItemIndicator>
										200%
									</Menu.RadioItem>
								</Menu.RadioGroup>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">Group &amp; submenu</p>
				<Menu.Root>
					<Menu.Trigger>Format</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner sideOffset={4}>
							<Menu.Popup>
								<Menu.Group>
									<Menu.GroupLabel>Align</Menu.GroupLabel>
									<Menu.Item>Left</Menu.Item>
									<Menu.Item>Center</Menu.Item>
									<Menu.Item>Right</Menu.Item>
								</Menu.Group>
								<Menu.Separator />
								<Menu.SubmenuRoot>
									<Menu.SubmenuTrigger>Arrange</Menu.SubmenuTrigger>
									<Menu.Portal>
										<Menu.Positioner sideOffset={8}>
											<Menu.Popup>
												<Menu.Item>Bring to front</Menu.Item>
												<Menu.Item>Send to back</Menu.Item>
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.SubmenuRoot>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <MenuShowcase />,
};
