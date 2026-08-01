import {
	CircleAlert,
	Info,
	Lightbulb,
	OctagonAlert,
	TriangleAlert,
} from "lucide-react";
import type { MDXComponents } from "mdx/types";
import React from "react";
import { Mermaid } from "@/app/_docsShell/Mermaid";

const CALLOUT_CONFIG = {
	note: {
		label: "Note",
		icon: Info,
		border: "border-blue-500/50",
		bg: "bg-blue-500/5",
		text: "text-blue-400",
	},
	tip: {
		label: "Tip",
		icon: Lightbulb,
		border: "border-green-500/50",
		bg: "bg-green-500/5",
		text: "text-green-400",
	},
	important: {
		label: "Important",
		icon: CircleAlert,
		border: "border-purple-500/50",
		bg: "bg-purple-500/5",
		text: "text-purple-400",
	},
	warning: {
		label: "Warning",
		icon: TriangleAlert,
		border: "border-amber-500/50",
		bg: "bg-amber-500/5",
		text: "text-amber-400",
	},
	caution: {
		label: "Caution",
		icon: OctagonAlert,
		border: "border-red-500/50",
		bg: "bg-red-500/5",
		text: "text-red-400",
	},
} as const;

type CalloutType = keyof typeof CALLOUT_CONFIG;

function parseGitHubCallout(children: React.ReactNode): {
	type: CalloutType;
	content: React.ReactNode;
} | null {
	const childArray = React.Children.toArray(children);
	if (childArray.length === 0) return null;

	const firstIdx = childArray.findIndex((c) => React.isValidElement(c));
	if (firstIdx === -1) return null;
	const first = childArray[firstIdx];

	const pChildren = React.Children.toArray(
		(first as React.ReactElement<{ children?: React.ReactNode }>).props
			.children,
	);
	if (pChildren.length === 0) return null;

	const pFirstIdx = pChildren.findIndex((c) => typeof c === "string");
	if (pFirstIdx === -1) return null;
	const firstText = pChildren[pFirstIdx] as string;

	const match = firstText.match(
		/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i,
	);
	if (!match) return null;

	const type = match[1].toLowerCase() as CalloutType;
	const remaining = firstText.slice(match[0].length).trimStart();

	const newPChildren = [
		...pChildren.slice(0, pFirstIdx),
		...(remaining ? [remaining] : []),
		...pChildren.slice(pFirstIdx + 1),
	];

	const content = [
		...(newPChildren.length > 0
			? [
					React.cloneElement(
						first as React.ReactElement,
						{ key: "callout-p0" },
						...newPChildren,
					),
				]
			: []),
		...childArray.slice(firstIdx + 1),
	];

	return { type, content };
}

// biome-ignore lint/correctness/noUnusedVariables: required by @next/mdx convention
export function useMDXComponents(): MDXComponents {
	return {
		h1: (props) => (
			<h1
				className="text-3xl font-bold mt-8 mb-4 first:mt-0 text-foreground"
				{...props}
			/>
		),
		h2: (props) => (
			<h2
				className="text-2xl font-semibold mt-8 mb-3 pb-2 border-b border-border text-foreground"
				{...props}
			/>
		),
		h3: (props) => (
			<h3
				className="text-xl font-semibold mt-6 mb-2 text-foreground"
				{...props}
			/>
		),
		p: (props) => (
			<p className="my-3 leading-7 text-foreground/90" {...props} />
		),
		ul: (props) => <ul className="my-3 ml-6 list-disc space-y-1" {...props} />,
		ol: (props) => (
			<ol className="my-3 ml-6 list-decimal space-y-1" {...props} />
		),
		li: (props) => <li className="leading-7" {...props} />,
		a: (props) => (
			<a className="text-accent underline hover:text-accent-hover" {...props} />
		),
		code: (props) => (
			<code
				className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono"
				{...props}
			/>
		),
		pre: ({ children, ...props }) => {
			const child = children as React.ReactElement<{
				className?: string;
				children?: string;
			}>;

			if (child?.props?.className?.includes("language-mermaid")) {
				return <Mermaid $chart={child.props.children ?? ""} />;
			}

			return (
				<pre
					className="my-4 overflow-x-auto rounded-lg bg-muted p-4 text-sm"
					{...props}
				>
					{children}
				</pre>
			);
		},
		blockquote: ({ children, ...props }) => {
			const callout = parseGitHubCallout(children);

			if (callout) {
				const config = CALLOUT_CONFIG[callout.type];
				const Icon = config.icon;
				return (
					<div
						className={`my-4 rounded-lg border-l-4 ${config.border} ${config.bg} px-4 py-3`}
					>
						<p
							className={`flex items-center gap-1.5 font-semibold text-sm ${config.text} !mt-0 mb-2`}
						>
							<Icon size={16} />
							{config.label}
						</p>
						{callout.content}
					</div>
				);
			}

			return (
				<blockquote
					className="my-4 border-l-4 border-accent pl-4 italic text-muted-foreground"
					{...props}
				>
					{children}
				</blockquote>
			);
		},
		table: (props) => (
			<div className="my-4 overflow-x-auto">
				<table className="w-full border-collapse text-sm" {...props} />
			</div>
		),
		th: (props) => (
			<th
				className="border border-border px-3 py-2 text-left font-semibold bg-muted"
				{...props}
			/>
		),
		td: (props) => <td className="border border-border px-3 py-2" {...props} />,
		img: (props) => (
			// eslint-disable-next-line @next/next/no-img-element
			<img className="my-4 max-w-full rounded" alt="" {...props} />
		),
	};
}
