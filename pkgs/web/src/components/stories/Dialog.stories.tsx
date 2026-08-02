import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Dialog } from "../Dialog";

const dialogVariants = [
	{
		id: "basic",
		title: "Project settings",
		description: "Edit project metadata and collaboration settings.",
		closeLabel: "Done",
	},
	{
		id: "confirmation",
		title: "Discard unsaved changes?",
		description: "Unsaved edits will be lost.",
		closeLabel: "Keep editing",
	},
] as const;

const meta = {
	title: "Components/Dialog",
	component: Dialog.Root,
} satisfies Meta<typeof Dialog.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {} as any,
	render: () => (
		<div className="grid gap-3 md:grid-cols-2">
			{dialogVariants.map((variant) => (
				<div
					key={variant.id}
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">{variant.id}</p>
					<Dialog.Root>
						<Dialog.Trigger>
							<button
								type="button"
								className="rounded border border-border bg-background px-3 py-2 text-sm"
							>
								Open dialog
							</button>
						</Dialog.Trigger>
						<Dialog.Content>
							<Dialog.Title>{variant.title}</Dialog.Title>
							<Dialog.Description>{variant.description}</Dialog.Description>
							<div className="flex items-center justify-end gap-2">
								<Dialog.Close className="rounded border border-border px-3 py-1.5 text-sm">
									Cancel
								</Dialog.Close>
								<Dialog.Close className="rounded bg-accent px-3 py-1.5 text-sm text-accent-foreground">
									{variant.closeLabel}
								</Dialog.Close>
							</div>
						</Dialog.Content>
					</Dialog.Root>
				</div>
			))}
		</div>
	),
};
