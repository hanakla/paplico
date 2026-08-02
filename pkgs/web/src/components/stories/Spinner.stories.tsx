import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Spinner } from "../Spinner";

const meta = {
	title: "Components/Spinner",
	component: Spinner,
	decorators: [
		(Story) => (
			<div style={{ textAlign: "center", padding: 40 }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof Spinner>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: { $size: "md" },
	render: () => (
		<div style={{ display: "flex", alignItems: "center", gap: 64 }}>
			{(["sm", "md", "lg"] as const).map((size) => (
				<div
					key={size}
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 12,
					}}
				>
					<Spinner $size={size} />
					<span style={{ fontSize: 12, opacity: 0.6 }}>{size}</span>
				</div>
			))}
		</div>
	),
};
