"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { twm } from "@/utils/tailwind";
import type { NavItem } from "./nav";

export function DocsSidebar({ title, nav }: { title: string; nav: NavItem[] }) {
	const pathname = usePathname();

	return (
		<nav className="flex flex-col gap-1 p-4">
			<h2 className="mb-2 px-2 text-sm font-semibold text-foreground">
				{title}
			</h2>
			{nav.map((item) => (
				<NavLink key={item.href} item={item} pathname={pathname} />
			))}
		</nav>
	);
}

function NavLink({
	item,
	pathname,
	depth = 0,
}: {
	item: NavItem;
	pathname: string;
	depth?: number;
}) {
	const isActive = pathname === item.href;

	return (
		<>
			<Link
				href={item.href}
				className={twm(
					"rounded-md px-2 py-1.5 text-sm transition-colors",
					isActive
						? "bg-accent text-accent-foreground font-medium"
						: "text-muted-foreground hover:bg-muted hover:text-foreground",
					depth > 0 && "ml-3",
				)}
			>
				{item.title}
			</Link>
			{item.children?.map((child) => (
				<NavLink
					key={child.href}
					item={child}
					pathname={pathname}
					depth={depth + 1}
				/>
			))}
		</>
	);
}
