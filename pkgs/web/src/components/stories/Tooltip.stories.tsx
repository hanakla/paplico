import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Tooltip } from "../Tooltip";

const sideVariants = ["top", "right", "bottom", "left"] as const;

const meta = {
	title: "Components/Tooltip",
	component: Tooltip,
} satisfies Meta<typeof Tooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {} as any,
	render: () => (
		<div className="space-y-3">
			<div className="grid gap-3 md:grid-cols-2">
				{sideVariants.map((side) => (
					<div
						key={side}
						className="space-y-2 rounded-md border border-border p-3"
					>
						<p className="text-xs text-muted-foreground">{`side = ${side}`}</p>
						<Tooltip content={`Tooltip on ${side}`} side={side}>
							<button
								type="button"
								className="rounded border border-border bg-background px-3 py-2 text-sm"
							>
								Hover me
							</button>
						</Tooltip>
					</div>
				))}
			</div>

			<div className="grid gap-3 md:grid-cols-2">
				<div className="space-y-2 rounded-md border border-border p-3">
					<p className="text-xs text-muted-foreground">delay = 600ms</p>
					<Tooltip content="Delayed tooltip" delay={600}>
						<button
							type="button"
							className="rounded border border-border bg-background px-3 py-2 text-sm"
						>
							Hover me
						</button>
					</Tooltip>
				</div>

				<div className="space-y-2 rounded-md border border-border p-3">
					<p className="text-xs text-muted-foreground">disabled</p>
					<Tooltip content="This tooltip is disabled" disabled>
						<button
							type="button"
							className="rounded border border-border bg-background px-3 py-2 text-sm"
						>
							Hover me
						</button>
					</Tooltip>
				</div>
			</div>
		</div>
	),
};
