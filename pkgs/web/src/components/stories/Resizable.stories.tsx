import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Resizable } from "../Resizable";

const meta = {
	title: "Components/Resizable",
	component: Resizable,
	args: {
		dir: "right",
		defaultSize: 160,
		children: null,
	},
} satisfies Meta<typeof Resizable>;

export default meta;

type Story = StoryObj<typeof meta>;

function ResizableShowcase() {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">horizontal (sidebar)</p>
				<div className="flex h-48 overflow-hidden rounded-md border border-border">
					<Resizable
						dir="right"
						defaultSize={160}
						minSize={100}
						maxSize={280}
						className="bg-muted/40"
					>
						<div className="h-full p-3 text-sm text-muted-foreground">
							Sidebar
						</div>
					</Resizable>
					<div className="flex-1 p-3 text-sm text-muted-foreground">
						Main content
					</div>
				</div>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">vertical (top panel)</p>
				<div className="flex h-48 flex-col overflow-hidden rounded-md border border-border">
					<Resizable
						dir="bottom"
						defaultSize={80}
						minSize={40}
						maxSize={140}
						className="bg-muted/40"
					>
						<div className="h-full p-3 text-sm text-muted-foreground">
							Top panel
						</div>
					</Resizable>
					<div className="flex-1 p-3 text-sm text-muted-foreground">
						Main content
					</div>
				</div>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <ResizableShowcase />,
};
