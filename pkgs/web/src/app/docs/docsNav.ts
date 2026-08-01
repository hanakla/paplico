import type { NavItem } from "../_docsShell/nav";

export const docsNav: NavItem[] = [
	{ title: "Introduction", href: "/docs" },
	{
		title: "オートメーション",
		href: "/docs/automation",
		children: [
			{ title: "スクリプト API", href: "/docs/automation/api" },
			{ title: "ファイルアクセス", href: "/docs/automation/filesystem" },
		],
	},
];
