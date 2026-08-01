import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ScrollArea } from "../ScrollArea";

const meta = {
	title: "Components/ScrollArea",
	component: ScrollArea.Root,
} satisfies Meta<typeof ScrollArea.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

const listItems = Array.from({ length: 40 }, (_, i) => `Item ${i + 1}`);

const paragraphs = Array.from(
	{ length: 12 },
	(_, i) =>
		`Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`,
);

function ScrollAreaShowcase() {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					default (scrollbar shown on hover)
				</p>
				<ScrollArea.Root className="h-56 rounded border border-border">
					<ScrollArea.Viewport>
						<ul className="p-2 text-sm">
							{listItems.map((item) => (
								<li key={item} className="px-2 py-1.5">
									{item}
								</li>
							))}
						</ul>
					</ScrollArea.Viewport>
				</ScrollArea.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">
					$displayBars (scrollbar always visible)
				</p>
				<ScrollArea.Root className="h-56 rounded border border-border">
					<ScrollArea.Viewport $displayBars>
						<ul className="p-2 text-sm">
							{listItems.map((item) => (
								<li key={item} className="px-2 py-1.5">
									{item}
								</li>
							))}
						</ul>
					</ScrollArea.Viewport>
				</ScrollArea.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3 md:col-span-2">
				<p className="text-xs text-muted-foreground">
					$fade (long text with edge fade mask)
				</p>
				<ScrollArea.Root className="h-56 rounded border border-border">
					<ScrollArea.Viewport $fade contentClassName="p-3">
						<div className="space-y-3 text-sm">
							{paragraphs.map((paragraph) => (
								<p key={paragraph}>{paragraph}</p>
							))}
						</div>
					</ScrollArea.Viewport>
				</ScrollArea.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3 md:col-span-2">
				<p className="text-xs text-muted-foreground">
					wide content (horizontal scrollbar)
				</p>
				<ScrollArea.Root className="h-20 rounded border border-border">
					<ScrollArea.Viewport $displayBars contentClassName="p-2">
						<div className="flex w-max gap-2">
							{listItems.map((item) => (
								<span
									key={item}
									className="shrink-0 rounded bg-muted px-3 py-1.5 text-sm"
								>
									{item}
								</span>
							))}
						</div>
					</ScrollArea.Viewport>
				</ScrollArea.Root>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <ScrollAreaShowcase />,
};
