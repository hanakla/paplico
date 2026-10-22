import { Github } from "lucide-react";
import Link from "next/link";
import { GITHUB_URL } from "../links";

const NAV = [
	{ href: "/core#features", label: "Features" },
	{ href: "/core#filters", label: "Demos" },
	{ href: "/core/docs", label: "Docs" },
];

const ORB_STYLE = {
	"--aero-orb": "linear-gradient(180deg, #4cc6f2, #0b5f9e)",
} as React.CSSProperties;

/** Sticky glass navigation bar of the landing page. */
export function SiteHeader() {
	return (
		<header className="sticky top-0 z-20 px-4 pt-3">
			<nav className="aero-glass mx-auto flex max-w-6xl items-center gap-6 rounded-full! px-5 py-2.5">
				<Link href="/core" className="flex items-center gap-2 font-bold">
					<span className="aero-orb size-6!" style={ORB_STYLE} />
					Paplico Core
				</Link>
				<div className="hidden gap-5 text-sm font-medium text-sky-950/75 sm:flex">
					{NAV.map((item) => (
						<Link
							key={item.href}
							href={item.href}
							className="transition-colors hover:text-sky-700"
						>
							{item.label}
						</Link>
					))}
				</div>
				<a
					href={GITHUB_URL}
					aria-label="GitHub"
					className="ml-auto text-sky-950/70 transition-colors hover:text-sky-700"
				>
					<Github className="size-5" />
				</a>
			</nav>
		</header>
	);
}
