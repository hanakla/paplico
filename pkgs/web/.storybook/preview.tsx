import type { Preview } from "@storybook/nextjs-vite";
import { LiquidGlassFilter } from "../src/components/LiquidGlassFilter";
import "../src/app/app.css";

const preview: Preview = {
	parameters: {
		layout: "centered",
		controls: { expanded: true },
	},
	decorators: [
		(Story, context) => {
			if (context.parameters.noThemeDecorator) {
				return <Story />;
			}
			return (
				<div className="grid w-[min(100vw-2rem,88rem)] gap-4 lg:grid-cols-2">
					<LiquidGlassFilter />
					<section className="space-y-3 rounded-md border border-border bg-background p-4 text-foreground">
						<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
							Light
						</p>
						<div className="bg-background">
							<Story />
						</div>
					</section>

					<div className="dark">
						<section className="space-y-3 rounded-md border border-border bg-background p-4 text-foreground">
							<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
								Dark
							</p>
							<div className="bg-background">
								<Story />
							</div>
						</section>
					</div>
				</div>
			);
		},
	],
};

export default preview;
