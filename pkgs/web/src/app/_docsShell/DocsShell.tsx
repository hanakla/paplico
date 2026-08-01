"use client";

import Link from "next/link";
import { useRef } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import { DocsSidebar } from "./DocsSidebar";
import { DocsToC } from "./DocsToC";
import type { NavItem } from "./nav";

export function DocsShell({
	title,
	nav,
	children,
}: {
	title: string;
	nav: NavItem[];
	children: React.ReactNode;
}) {
	const mainRef = useRef<HTMLDivElement>(null);

	return (
		<div
			className="fixed inset-0 z-50 grid grid-cols-[240px_1fr_200px] grid-rows-[auto_1fr] bg-background"
			data-docs
		>
			{/* Header */}
			<header className="col-span-3 flex items-center gap-3 border-b border-border px-4 py-2">
				<Link
					href="/"
					className="text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					&larr; Back to App
				</Link>
				<span className="text-sm font-semibold text-foreground">{title}</span>
			</header>

			{/* Sidebar */}
			<ScrollArea.Root className="border-r border-border">
				<ScrollArea.Viewport>
					<DocsSidebar title={title} nav={nav} />
				</ScrollArea.Viewport>
			</ScrollArea.Root>

			{/* Main content */}
			<ScrollArea.Root>
				<ScrollArea.Viewport ref={mainRef}>
					<main className="mx-auto max-w-3xl px-8 py-8">{children}</main>
				</ScrollArea.Viewport>
			</ScrollArea.Root>

			{/* Table of Contents */}
			<ScrollArea.Root className="border-l border-border">
				<ScrollArea.Viewport>
					<DocsToC $contentRef={mainRef} />
				</ScrollArea.Viewport>
			</ScrollArea.Root>
		</div>
	);
}
