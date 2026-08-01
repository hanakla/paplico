import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { type KeyboardEvent, useState } from "react";
import { expect, fn, userEvent } from "storybook/test";
import { Clickable } from "../Clickable";

const meta = {
	title: "Components/Clickable",
	component: Clickable,
} satisfies Meta<typeof Clickable>;

export default meta;

type Story = StoryObj<typeof meta>;

function ClickableDemo() {
	const [events, setEvents] = useState<string[]>([]);

	const pushEvent = (label: string) => (event: KeyboardEvent) => {
		setEvents((prev) => [`${label}: ${event.key}`, ...prev].slice(0, 6));
	};

	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">default (div)</p>
				<Clickable
					className="rounded border border-border bg-background px-3 py-2 text-sm"
					onKeyDown={pushEvent("div")}
				>
					Focus and press Enter / Space
				</Clickable>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">as button</p>
				<Clickable
					as="button"
					type="button"
					className="rounded border border-border bg-background px-3 py-2 text-sm"
					onKeyDown={pushEvent("button")}
				>
					Button element
				</Clickable>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">as anchor</p>
				<Clickable
					as="a"
					href="#"
					onClick={(event) => event.preventDefault()}
					className="inline-flex rounded border border-border bg-background px-3 py-2 text-sm"
					onKeyDown={pushEvent("anchor")}
				>
					Anchor element
				</Clickable>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">recent key events</p>
				<ul className="space-y-1 text-xs text-foreground">
					{events.length > 0 ? (
						events.map((entry) => <li key={entry}>{entry}</li>)
					) : (
						<li className="text-muted-foreground">No key events yet</li>
					)}
				</ul>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <ClickableDemo />,
};

export const EnterKeyTriggersClick: Story = {
	args: { onClick: fn(), children: "Press Enter" },
	render: (args) => (
		<Clickable
			data-testid="enter-target"
			className="rounded border border-border bg-background px-3 py-2 text-sm"
			{...args}
		/>
	),
	play: async ({ canvasElement, args, step }) => {
		const el = canvasElement.querySelector<HTMLElement>(
			"[data-testid='enter-target']",
		)!;

		await step("Focus the element", async () => {
			el.focus();
			await expect(el).toHaveFocus();
		});

		await step("Press Enter triggers onClick", async () => {
			await userEvent.keyboard("{Enter}");
			await expect(args.onClick).toHaveBeenCalledTimes(1);
		});
	},
};

export const SpaceKeyTriggersClick: Story = {
	args: { onClick: fn(), children: "Press Space" },
	render: (args) => (
		<Clickable
			data-testid="space-target"
			className="rounded border border-border bg-background px-3 py-2 text-sm"
			{...args}
		/>
	),
	play: async ({ canvasElement, args, step }) => {
		const el = canvasElement.querySelector<HTMLElement>(
			"[data-testid='space-target']",
		)!;

		await step("Focus the element", async () => {
			el.focus();
			await expect(el).toHaveFocus();
		});

		await step("Press Space triggers onClick", async () => {
			await userEvent.keyboard(" ");
			await expect(args.onClick).toHaveBeenCalledTimes(1);
		});
	},
};

export const HasTabIndex: Story = {
	args: { children: "Focusable" },
	render: (args) => (
		<Clickable
			data-testid="tabindex-target"
			className="rounded border border-border bg-background px-3 py-2 text-sm"
			{...args}
		/>
	),
	play: async ({ canvasElement, step }) => {
		const el = canvasElement.querySelector<HTMLElement>(
			"[data-testid='tabindex-target']",
		)!;

		await step("Element has tabindex=0", async () => {
			await expect(el).toHaveAttribute("tabindex", "0");
		});
	},
};

const asButtonClickHandler = fn();
export const AsButton: Story = {
	render: () => (
		<Clickable
			as="button"
			data-testid="button-target"
			className="rounded border border-border bg-background px-3 py-2 text-sm"
			onClick={asButtonClickHandler}
		>
			Button
		</Clickable>
	),
	play: async ({ canvasElement, step }) => {
		const el = canvasElement.querySelector<HTMLElement>(
			"[data-testid='button-target']",
		)!;

		await step("Renders as button element", async () => {
			await expect(el.tagName).toBe("BUTTON");
		});

		await step("Click triggers onClick", async () => {
			await userEvent.click(el);
			await expect(asButtonClickHandler).toHaveBeenCalledTimes(1);
		});
	},
};
