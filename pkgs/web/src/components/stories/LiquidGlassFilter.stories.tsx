import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LiquidGlassFilter } from "../LiquidGlassFilter";

const meta = {
	title: "Components/LiquidGlassFilter",
	component: LiquidGlassFilter,
} satisfies Meta<typeof LiquidGlassFilter>;

export default meta;

type Story = StoryObj<typeof meta>;

// LiquidGlassFilter renders nothing visible by itself -- it only injects a hidden
// <svg><filter id="liquid-glass-frosted"> that the `backdrop-liquid` Tailwind
// utility (app.css) references via `url(#liquid-glass-frosted)`. The global
// Storybook decorator (.storybook/preview.tsx) already mounts one instance for
// every story, so this demo reuses that filter through the utility class instead
// of mounting the component again, which would emit a second element with the
// same id.
function LiquidGlassFilterShowcase() {
	return (
		<div
			className="grid gap-4 rounded-md p-6 md:grid-cols-2"
			style={{
				background:
					"conic-gradient(from 90deg, #f97316, #ec4899, #6366f1, #06b6d4, #22c55e, #f97316)",
			}}
		>
			<div className="rounded-lg border border-white/40 bg-white/10 p-4 text-sm font-medium text-white">
				No filter
			</div>
			<div className="rounded-lg border border-white/40 bg-white/10 p-4 text-sm font-medium text-white backdrop-liquid">
				backdrop-liquid applied
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <LiquidGlassFilterShowcase />,
};
