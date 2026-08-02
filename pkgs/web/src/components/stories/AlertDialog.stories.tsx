import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AlertDialog } from "../AlertDialog";

const alertVariants = [
	{
		id: "default",
		title: "Delete layer?",
		description: "This action removes the selected layer from the document.",
		confirmLabel: "Delete",
		confirmClassName:
			"bg-destructive text-destructive-foreground hover:bg-destructive/90",
		triggerDisabled: false,
	},
	{
		id: "archive",
		title: "Archive project?",
		description: "Archived projects can be restored later from Settings.",
		confirmLabel: "Archive",
		confirmClassName: "bg-accent text-accent-foreground hover:bg-accent/90",
		triggerDisabled: false,
	},
	{
		id: "disabled-trigger",
		title: "Disabled trigger",
		description: "Trigger disabled state preview.",
		confirmLabel: "Confirm",
		confirmClassName: "bg-accent text-accent-foreground hover:bg-accent/90",
		triggerDisabled: true,
	},
] as const;

const meta = {
	title: "Components/AlertDialog",
	component: AlertDialog.Root,
} satisfies Meta<typeof AlertDialog.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: () => (
		<div className="grid gap-3 md:grid-cols-3">
			{alertVariants.map((variant) => (
				<div key={variant.id} className="rounded-md border border-border p-3">
					<p className="mb-2 text-xs text-muted-foreground">{variant.id}</p>
					<AlertDialog.Root>
						<AlertDialog.Trigger disabled={variant.triggerDisabled}>
							Open alert
						</AlertDialog.Trigger>
						<AlertDialog.Portal>
							<AlertDialog.Backdrop />
							<AlertDialog.Viewport>
								<AlertDialog.Popup>
									<AlertDialog.Title>{variant.title}</AlertDialog.Title>
									<AlertDialog.Description>
										{variant.description}
									</AlertDialog.Description>
									<div className="flex items-center justify-end gap-2">
										<AlertDialog.Close>Cancel</AlertDialog.Close>
										<AlertDialog.Close className={variant.confirmClassName}>
											{variant.confirmLabel}
										</AlertDialog.Close>
									</div>
								</AlertDialog.Popup>
							</AlertDialog.Viewport>
						</AlertDialog.Portal>
					</AlertDialog.Root>
				</div>
			))}
		</div>
	),
};
