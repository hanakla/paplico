import type { Meta, StoryObj } from "@storybook/nextjs-vite";

const meta = {
	title: "Design/Colors",
	parameters: {
		layout: "fullscreen",
		noThemeDecorator: true,
	},
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const THEMES = [
	{ label: "Default", cls: "" },
	{ label: "Dark", cls: "dark" },
	{ label: "Pink", cls: "pink" },
	{ label: "Lime", cls: "lime" },
	{ label: "Purple", cls: "purple" },
	{ label: "Black", cls: "black" },
	{ label: "White", cls: "white" },
] as const;

type Swatch = { label: string; bg?: string; border?: string; text?: string };

const GROUPS: { label: string; swatches: Swatch[] }[] = [
	{
		label: "background / foreground",
		swatches: [
			{ label: "background", bg: "bg-background", text: "text-foreground" },
		],
	},
	{
		label: "muted",
		swatches: [
			{ label: "muted", bg: "bg-muted", text: "text-muted-foreground" },
			{
				label: "muted-hover",
				bg: "bg-muted-hover",
				text: "text-muted-foreground",
			},
			{
				label: "muted-active",
				bg: "bg-muted-active",
				text: "text-muted-foreground",
			},
		],
	},
	{
		label: "accent",
		swatches: [
			{ label: "accent", bg: "bg-accent", text: "text-accent-foreground" },
			{
				label: "accent-hover",
				bg: "bg-accent-hover",
				text: "text-accent-foreground",
			},
			{
				label: "accent-active",
				bg: "bg-accent-active",
				text: "text-accent-foreground",
			},
		],
	},
	{
		label: "danger",
		swatches: [
			{ label: "danger", bg: "bg-danger", text: "text-danger-foreground" },
			{
				label: "danger-hover",
				bg: "bg-danger-hover",
				text: "text-danger-foreground",
			},
			{
				label: "danger-active",
				bg: "bg-danger-active",
				text: "text-danger-foreground",
			},
		],
	},
	{
		label: "warn",
		swatches: [
			{ label: "warn", bg: "bg-warn", text: "text-warn-foreground" },
			{
				label: "warn-hover",
				bg: "bg-warn-hover",
				text: "text-warn-foreground",
			},
			{
				label: "warn-active",
				bg: "bg-warn-active",
				text: "text-warn-foreground",
			},
		],
	},
	{
		label: "border",
		swatches: [
			{ label: "border", border: "border-border" },
			{ label: "border-active", border: "border-border-active" },
		],
	},
	{
		label: "success",
		swatches: [{ label: "success", bg: "bg-success" }],
	},
	{
		label: "virtual-shiftkey",
		swatches: [
			{
				label: "shiftkey",
				bg: "bg-virtual-shiftkey",
				text: "text-virtual-shiftkey-foreground",
			},
			{
				label: "shiftkey-hover",
				bg: "bg-virtual-shiftkey-hover",
				text: "text-virtual-shiftkey-foreground",
			},
			{
				label: "shiftkey-active",
				bg: "bg-virtual-shiftkey-active",
				text: "text-virtual-shiftkey-foreground",
			},
			{
				label: "shiftkey-pressed",
				bg: "bg-virtual-shiftkey-pressed",
				text: "text-virtual-shiftkey-foreground",
			},
		],
	},
];

function SwatchBox({ bg, border, text, label }: Swatch) {
	return (
		<div className="flex flex-col gap-1">
			<div
				className={`${bg ?? "bg-background"} flex h-12 w-full items-center justify-center rounded ${border ? `border-4 ${border}` : "border border-black/10"}`}
			>
				{text && <span className={`${text} text-xs font-medium`}>Aa</span>}
			</div>
			<span className="text-[10px] text-gray-500 leading-tight">{label}</span>
		</div>
	);
}

function ThemeSection({ label, cls }: { label: string; cls: string }) {
	return (
		<div
			className={`${cls} bg-background rounded-lg border border-black/10 p-4`}
		>
			<p className="text-foreground mb-4 text-sm font-semibold">{label}</p>
			<div className="flex flex-col gap-4">
				{GROUPS.map((group) => (
					<div key={group.label}>
						<p className="text-foreground/50 mb-2 text-[10px] uppercase tracking-wide">
							{group.label}
						</p>
						<div
							className="grid gap-2"
							style={{
								gridTemplateColumns: `repeat(${group.swatches.length}, minmax(0, 1fr))`,
							}}
						>
							{group.swatches.map((s) => (
								<SwatchBox key={s.label} {...s} />
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export const AllThemes: Story = {
	render: () => (
		<div style={{ overflowY: "auto", height: "100dvh" }}>
			<div
				className="grid gap-4 p-6"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
			>
				{THEMES.map((t) => (
					<ThemeSection key={t.label} label={t.label} cls={t.cls} />
				))}
			</div>
		</div>
	),
};
