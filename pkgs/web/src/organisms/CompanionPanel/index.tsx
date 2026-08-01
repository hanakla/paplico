"use client";

import {
	Layers,
	Palette,
	Redo,
	Sparkles,
	Undo,
	Wrench,
	X as XIcon,
} from "lucide-react";
import { memo, useState } from "react";
import type {
	CompanionCommand,
	CompanionState,
} from "@/companion/companionProtocol";
import { Icons } from "@/components/Icons";
import { Spinner } from "@/components/Spinner";
import type { CompanionConnectionStatus } from "@/hooks/useCompanionClient";
import {
	LocaleOverrideProvider,
	type LocalizeKeys,
	useTranslation,
} from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { BrushPane } from "./BrushPane";
import { ColorPane } from "./ColorPane";
import { LayerPane } from "./LayerPane";
import { ObjectPane } from "./ObjectPane";
import { ToolPane } from "./ToolPane";

type PaneKey = "color" | "brush" | "tool" | "object" | "layer";

const PANES: { key: PaneKey; labelKey: LocalizeKeys; icon: React.ReactNode }[] =
	[
		{
			key: "color",
			labelKey: "companion.tabColor",
			icon: <Palette size={18} />,
		},
		{
			key: "brush",
			labelKey: "companion.tabBrush",
			icon: <Icons.Pen size={18} />,
		},
		{ key: "tool", labelKey: "companion.tabTool", icon: <Wrench size={18} /> },
		{
			key: "object",
			labelKey: "companion.tabObject",
			icon: <Sparkles size={18} />,
		},
		{
			key: "layer",
			labelKey: "companion.tabLayer",
			icon: <Layers size={18} />,
		},
	];

/**
 * The remote control itself, with no idea how it is connected. The page at
 * /companion and the in-app modal both render this, so the two stay the same
 * thing rather than drifting into two half-features.
 */
export const CompanionPanel = memo(function CompanionPanel({
	state,
	status,
	onCommand,
	withSafeAreaInsets = false,
	onClose,
}: {
	state: CompanionState | null;
	status: CompanionConnectionStatus;
	onCommand: (command: CompanionCommand) => void;
	/** Shown as a close button when the panel lives in a dismissable surface. */
	onClose?: () => void;
	/**
	 * Add the notch and home indicator gaps. The in-app modal already sits
	 * clear of both, so only the full-page use needs them.
	 */
	withSafeAreaInsets?: boolean;
}) {
	const t = useTranslation();
	const [pane, setPane] = useState<PaneKey>("color");

	const handleUndo = useEventCallback(() => onCommand({ type: "undo" }));
	const handleRedo = useEventCallback(() => onCommand({ type: "redo" }));

	const handleTabClick = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const next = e.currentTarget.dataset.pane as PaneKey | undefined;
			if (next) setPane(next);
		},
	);

	// Sized by the panel's own box, not the viewport: inside a resizable modal
	// the window's width says nothing about how much room this panel has. Below
	// @md (28rem) the tabs are a bottom bar within a thumb's reach; anything
	// wider has width to spare and height to protect, so they move to the side.
	const tabs = (
		<nav
			className={twm(
				"flex shrink-0 bg-background/80 backdrop-blur-sm",
				"flex-row border-t border-border order-last",
				"@md:flex-col @md:border-t-0 @md:border-r @md:order-none",
				withSafeAreaInsets && "pb-safe-bottom @md:pb-0 @md:pl-safe-left",
			)}
		>
			{PANES.map(({ key, labelKey, icon }) => (
				<button
					key={key}
					type="button"
					data-pane={key}
					onClick={handleTabClick}
					className={twm(
						"flex flex-col items-center justify-center gap-0.5 transition-colors",
						"flex-1 min-w-0 h-14 @md:flex-none @md:w-16 @md:h-16",
						key === pane
							? "text-accent"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{icon}
					<span className="text-[10px] truncate max-w-full px-0.5">
						{t(labelKey)}
					</span>
				</button>
			))}
		</nav>
	);

	return (
		<LocaleOverrideProvider locale={state?.language ?? null}>
			<div className="@container flex flex-col h-full min-h-0 bg-background text-foreground">
				<header
					className={twm(
						"flex items-center gap-2 px-3 h-12 shrink-0 border-b border-border",
						withSafeAreaInsets && "pt-safe-top h-auto min-h-12",
					)}
				>
					{/* Undo and redo lead: they are what the header is reached for.
					    The connection status is a glance, not a control, so it sits
					    out of the way at the far edge. */}
					<div className="flex items-center gap-1 shrink-0">
						<button
							type="button"
							aria-label={t("companion.undo")}
							disabled={!state?.canUndo}
							onClick={handleUndo}
							className="size-11 flex items-center justify-center rounded-lg disabled:opacity-30"
						>
							<Undo size={18} />
						</button>
						<button
							type="button"
							aria-label={t("companion.redo")}
							disabled={!state?.canRedo}
							onClick={handleRedo}
							className="size-11 flex items-center justify-center rounded-lg disabled:opacity-30"
						>
							<Redo size={18} />
						</button>
					</div>

					<div className="flex items-center gap-2 ml-auto min-w-0">
						<span className="text-sm text-muted-foreground truncate">
							{t(statusLabelKey(status))}
						</span>
						<span
							className={twm(
								"size-2 rounded-full shrink-0",
								status === "connected" ? "bg-accent" : "bg-muted-foreground",
							)}
						/>
					</div>

					{onClose && (
						<button
							type="button"
							aria-label={t("companion.close")}
							onClick={onClose}
							className="size-11 -mr-2 flex items-center justify-center rounded-lg shrink-0"
						>
							<XIcon size={18} />
						</button>
					)}
				</header>

				<div className="flex flex-1 min-h-0 flex-col @md:flex-row">
					{tabs}
					<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
						{status === "ended" ? (
							<Notice
								title={t("companion.sessionEnded")}
								description={t("companion.sessionEndedDescription")}
							/>
						) : state ? (
							<>
								{pane === "color" && (
									<ColorPane state={state} onCommand={onCommand} />
								)}
								{pane === "brush" && (
									<BrushPane state={state} onCommand={onCommand} />
								)}
								{pane === "tool" && (
									<ToolPane state={state} onCommand={onCommand} />
								)}
								{pane === "object" && (
									<ObjectPane state={state} onCommand={onCommand} />
								)}
								{pane === "layer" && (
									<LayerPane state={state} onCommand={onCommand} />
								)}
							</>
						) : (
							<div className="flex items-center justify-center h-full p-8">
								<Spinner $size="md" />
							</div>
						)}
					</div>
				</div>
			</div>
		</LocaleOverrideProvider>
	);
});

function Notice({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 h-full p-8 text-center">
			<p className="text-sm">{title}</p>
			<p className="text-xs text-muted-foreground">{description}</p>
		</div>
	);
}

function statusLabelKey(status: CompanionConnectionStatus): LocalizeKeys {
	switch (status) {
		case "connected":
			return "companion.connected";
		case "connecting":
			return "companion.connecting";
		case "disconnected":
			return "companion.disconnected";
		case "ended":
			return "companion.sessionEnded";
	}
}
