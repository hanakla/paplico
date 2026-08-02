"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

type Heading = {
	id: string;
	text: string;
	level: number;
};

export function DocsToC({
	$contentRef,
}: {
	$contentRef: React.RefObject<HTMLElement | null>;
}) {
	const pathname = usePathname();
	const [headings, setHeadings] = useState<Heading[]>([]);
	const [activeId, setActiveId] = useState<string>("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: $contentRef is a stable ref, pathname triggers re-read
	useEffect(() => {
		const el = $contentRef.current;
		if (!el) return;

		requestAnimationFrame(() => {
			const nodes = el.querySelectorAll("h2, h3");
			const items: Heading[] = Array.from(nodes)
				.filter((node) => node.id)
				.map((node) => ({
					id: node.id,
					text: node.textContent ?? "",
					level: Number(node.tagName[1]),
				}));
			setHeadings(items);
		});
	}, [pathname, $contentRef]);

	useEffect(() => {
		const el = $contentRef.current;
		if (!el || headings.length === 0) return;

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setActiveId(entry.target.id);
					}
				}
			},
			{ root: el, rootMargin: "0px 0px -80% 0px", threshold: 0 },
		);

		for (const { id } of headings) {
			const node = el.querySelector(`#${CSS.escape(id)}`);
			if (node) observer.observe(node);
		}

		return () => observer.disconnect();
	}, [headings, $contentRef]);

	const handleClick = useEventCallback(
		(e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
			e.preventDefault();
			const el = $contentRef.current?.querySelector(`#${CSS.escape(id)}`);
			el?.scrollIntoView({ behavior: "smooth", block: "start" });
		},
	);

	if (headings.length === 0) return null;

	return (
		<nav className="flex flex-col gap-1 p-4">
			<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
				On this page
			</h3>
			{headings.map((h) => (
				<a
					key={h.id}
					href={`#${h.id}`}
					onClick={(e) => handleClick(e, h.id)}
					className={twm(
						"text-xs leading-5 transition-colors",
						h.level === 3 && "pl-3",
						activeId === h.id
							? "text-accent font-medium"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{h.text}
				</a>
			))}
		</nav>
	);
}
