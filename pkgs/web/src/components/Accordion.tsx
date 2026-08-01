import { Accordion as BUIAccordion } from "@base-ui/react/accordion";
import { memo, type ReactNode } from "react";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

export const Accordion = {
	Root: memo(AccordionRoot),
	Item: memo(AccordionItem),
	Header: memo(AccordionHeader),
	Trigger: memo(AccordionTrigger),
	Panel: memo(AccordionPanel),
};

function AccordionRoot({
	children,
	...props
}: {
	children: ReactNode;
} & Pick<
	BUIAccordion.Root.Props,
	| "value"
	| "defaultValue"
	| "onValueChange"
	| "multiple"
	| "disabled"
	| "orientation"
	| "keepMounted"
>) {
	return <BUIAccordion.Root {...props}>{children}</BUIAccordion.Root>;
}

function AccordionItem({
	className,
	...props
}: PropsWithNativeClassName<BUIAccordion.Item.Props>) {
	return <BUIAccordion.Item className={className} {...props} />;
}

function AccordionHeader({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<BUIAccordion.Header className={twm(className)}>
			{children}
		</BUIAccordion.Header>
	);
}

function AccordionTrigger({
	className,
	...props
}: PropsWithNativeClassName<BUIAccordion.Trigger.Props>) {
	return (
		<BUIAccordion.Trigger
			className={twm("outline-none cursor-pointer w-full", className)}
			{...props}
		/>
	);
}

function AccordionPanel({
	className,
	...props
}: PropsWithNativeClassName<BUIAccordion.Panel.Props>) {
	return (
		<BUIAccordion.Panel
			className={twm(
				"overflow-hidden",
				"transition-[height] duration-200 ease-in-out",
				"data-[starting-style]:h-0",
				"data-[ending-style]:h-0",
				className,
			)}
			{...props}
		/>
	);
}
