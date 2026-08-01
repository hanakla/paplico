import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PenLine } from "lucide-react";
import { IconButton } from "../IconButton";

const variants = ["default", "secondary", "ghost", "destructive"] as const;
const sizes = ["xs", "sm", "md", "lg"] as const;

const meta = {
	title: "Components/IconButton",
	component: IconButton,
	args: {
		$variant: "secondary",
		$size: "md",
		$pressed: false,
		disabled: false,
	},
	argTypes: {
		$variant: {
			control: "inline-radio",
			options: ["default", "secondary", "ghost", "destructive"],
		},
		$size: {
			control: "inline-radio",
			options: ["xs", "sm", "md", "lg"],
		},
		$pressed: { control: "boolean" },
	},
} satisfies Meta<typeof IconButton>;

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
							<IconButton
								key={`${variant}-${size}`}
								$variant={variant}
								$size={size}
							>
								<PenLine size={14} />
							</IconButton>
						))}
						<IconButton $variant={variant} $pressed>
							<PenLine size={14} />
						</IconButton>
						<IconButton $variant={variant} disabled>
							<PenLine size={14} />
						</IconButton>
					</div>
				</div>
			))}
		</div>
	),
};
