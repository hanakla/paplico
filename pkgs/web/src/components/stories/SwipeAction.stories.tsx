import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { SwipeAction } from "../SwipeAction";

const meta = {
	title: "Components/SwipeAction",
	component: SwipeAction.Root,
} satisfies Meta<typeof SwipeAction.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

function Row({ label, sub }: { label: string; sub: string }) {
	return (
		<div className="flex items-center gap-3 px-4 py-3 bg-background border border-border rounded-lg">
			<div className="w-8 h-8 rounded-full bg-muted" />
			<div>
				<div className="text-sm font-medium">{label}</div>
				<div className="text-xs text-muted-foreground">{sub}</div>
			</div>
		</div>
	);
}

function SwipeActionShowcase() {
	return (
		<div className="grid gap-3 max-w-sm">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">single action</p>
				<SwipeAction.Root>
					<SwipeAction.Actions>
						<SwipeAction.Action
							onClick={() => alert("Delete")}
							className="bg-destructive text-destructive-foreground"
						>
							<Trash2 size={16} />
						</SwipeAction.Action>
					</SwipeAction.Actions>
					<SwipeAction.Content>
						<Row label="Document A" sub="Swipe left to delete" />
					</SwipeAction.Content>
				</SwipeAction.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">multiple actions</p>
				<SwipeAction.Root>
					<SwipeAction.Actions>
						<SwipeAction.Action
							onClick={() => alert("Edit")}
							className="bg-accent text-accent-foreground"
						>
							<Pencil size={16} />
						</SwipeAction.Action>
						<SwipeAction.Action
							onClick={() => alert("Copy")}
							className="bg-muted text-foreground"
						>
							<Copy size={16} />
						</SwipeAction.Action>
						<SwipeAction.Action
							onClick={() => alert("Delete")}
							className="bg-destructive text-destructive-foreground"
						>
							<Trash2 size={16} />
						</SwipeAction.Action>
					</SwipeAction.Actions>
					<SwipeAction.Content>
						<Row label="Document B" sub="3 actions" />
					</SwipeAction.Content>
				</SwipeAction.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled</p>
				<SwipeAction.Root disabled>
					<SwipeAction.Actions>
						<SwipeAction.Action
							onClick={() => alert("Delete")}
							className="bg-destructive text-destructive-foreground"
						>
							<Trash2 size={16} />
						</SwipeAction.Action>
					</SwipeAction.Actions>
					<SwipeAction.Content>
						<Row label="Document C" sub="Swipe disabled" />
					</SwipeAction.Content>
				</SwipeAction.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">list</p>
				<div className="space-y-1">
					{["Alpha", "Beta", "Gamma"].map((name) => (
						<SwipeAction.Root key={name}>
							<SwipeAction.Actions>
								<SwipeAction.Action
									onClick={() => alert(`Delete ${name}`)}
									className="bg-destructive text-destructive-foreground"
								>
									<Trash2 size={16} />
								</SwipeAction.Action>
							</SwipeAction.Actions>
							<SwipeAction.Content>
								<Row label={`Project ${name}`} sub="2h ago" />
							</SwipeAction.Content>
						</SwipeAction.Root>
					))}
				</div>
			</div>
		</div>
	);
}

export const Playground: Story = {
	args: {
		children: null,
	},
	render: () => <SwipeActionShowcase />,
};
