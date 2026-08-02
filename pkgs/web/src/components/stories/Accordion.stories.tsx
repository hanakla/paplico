import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Accordion } from "../Accordion";

const meta = {
	title: "Components/Accordion",
	component: Accordion.Root,
	args: {
		children: null,
	},
} satisfies Meta<typeof Accordion.Root>;

export default meta;

type Story = StoryObj<typeof meta>;

const FAQ_ITEMS = [
	{
		value: "what",
		question: "What is Paplico?",
		answer:
			"An infinite canvas drawing application built for real-time collaboration.",
	},
	{
		value: "how",
		question: "How does collaboration work?",
		answer: "Yjs CRDT syncs document state between clients automatically.",
	},
	{
		value: "cost",
		question: "Is it free to use?",
		answer: "Yes, the core drawing engine is free and open source.",
	},
];

function AccordionShowcase() {
	const [singleValue, setSingleValue] = useState<string[]>(["what"]);
	const [multiValue, setMultiValue] = useState<string[]>(["what", "how"]);

	return (
		<div className="grid gap-3 md:grid-cols-3">
			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">single</p>
				<Accordion.Root value={singleValue} onValueChange={setSingleValue}>
					{FAQ_ITEMS.map((item) => (
						<Accordion.Item key={item.value} value={item.value}>
							<Accordion.Header className="m-0">
								<Accordion.Trigger className="group flex w-full items-center justify-between rounded-md px-1 py-1.5 text-sm transition-colors hover:bg-foreground/[0.04]">
									<span>{item.question}</span>
									<ChevronDown
										size={14}
										className="shrink-0 transition-transform group-data-panel-open:rotate-180"
									/>
								</Accordion.Trigger>
							</Accordion.Header>
							<Accordion.Panel>
								<p className="px-1 pb-2 text-xs text-muted-foreground">
									{item.answer}
								</p>
							</Accordion.Panel>
						</Accordion.Item>
					))}
				</Accordion.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">multiple</p>
				<Accordion.Root
					multiple
					value={multiValue}
					onValueChange={setMultiValue}
				>
					{FAQ_ITEMS.map((item) => (
						<Accordion.Item key={item.value} value={item.value}>
							<Accordion.Header className="m-0">
								<Accordion.Trigger className="group flex w-full items-center justify-between rounded-md px-1 py-1.5 text-sm transition-colors hover:bg-foreground/[0.04]">
									<span>{item.question}</span>
									<ChevronDown
										size={14}
										className="shrink-0 transition-transform group-data-panel-open:rotate-180"
									/>
								</Accordion.Trigger>
							</Accordion.Header>
							<Accordion.Panel>
								<p className="px-1 pb-2 text-xs text-muted-foreground">
									{item.answer}
								</p>
							</Accordion.Panel>
						</Accordion.Item>
					))}
				</Accordion.Root>
			</div>

			<div className="space-y-2 rounded-md border border-border p-3">
				<p className="text-xs text-muted-foreground">disabled item</p>
				<Accordion.Root defaultValue={["what"]}>
					{FAQ_ITEMS.map((item, index) => (
						<Accordion.Item
							key={item.value}
							value={item.value}
							disabled={index === 1}
						>
							<Accordion.Header className="m-0">
								<Accordion.Trigger className="group flex w-full items-center justify-between rounded-md px-1 py-1.5 text-sm transition-colors hover:bg-foreground/[0.04] data-disabled:opacity-40 data-disabled:pointer-events-none">
									<span>{item.question}</span>
									<ChevronDown
										size={14}
										className="shrink-0 transition-transform group-data-panel-open:rotate-180"
									/>
								</Accordion.Trigger>
							</Accordion.Header>
							<Accordion.Panel>
								<p className="px-1 pb-2 text-xs text-muted-foreground">
									{item.answer}
								</p>
							</Accordion.Panel>
						</Accordion.Item>
					))}
				</Accordion.Root>
			</div>
		</div>
	);
}

export const Playground: Story = {
	render: () => <AccordionShowcase />,
};
