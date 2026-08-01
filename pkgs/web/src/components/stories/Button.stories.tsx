import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Button } from "../Button";

const variants = ["default", "secondary", "ghost", "destructive"] as const;
const sizes = ["sm", "md", "lg", "icon"] as const;

const meta = {
	title: "Components/Button",
	component: Button,
	args: {
		children: "Button",
		$variant: "default",
		$size: "md",
		disabled: false,
	},
	argTypes: {
		$variant: {
			control: "inline-radio",
			options: ["default", "secondary", "ghost", "destructive"],
		},
		$size: {
			control: "inline-radio",
			options: ["sm", "md", "lg", "icon"],
		},
	},
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: () => (
		<div className="grid gap-3 md:grid-cols-2">
			{variants.map((variant) => (
				<div key={variant} className="rounded-md border border-border p-3">
					<p className="mb-2 text-xs text-muted-foreground">{variant}</p>
					<div className="flex flex-wrap items-center gap-2">
						{sizes.map((size) => (
							<Button
								key={`${variant}-${size}`}
								$variant={variant}
								$size={size}
							>
								{size === "icon" ? "I" : size}
							</Button>
						))}
						<Button $variant={variant} disabled>
							disabled
						</Button>
					</div>
				</div>
			))}
		</div>
	),
};
