import {
	Eraser,
	MousePointer,
	PaintBucket,
	Pen,
	PenTool,
	Pipette,
	Route,
	Square,
	Type,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import type {
	CompanionCommand,
	CompanionState,
} from "@/companion/companionProtocol";
import type { ToolType } from "@/core/tools/toolSettings";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

/**
 * The tools worth reaching for without a canvas in front of you. Tools that
 * only make sense while looking at what they act on — transform, mesh deform,
 * artboard — are left to the device holding the canvas.
 */
const COMPANION_TOOLS: {
	tool: ToolType;
	labelKey: LocalizeKeys;
	icon: ReactNode;
}[] = [
	{ tool: "pen", labelKey: "toolbar.penTool", icon: <Pen size={20} /> },
	{
		tool: "eraser",
		labelKey: "toolbar.eraserTool",
		icon: <Eraser size={20} />,
	},
	{
		tool: "eyedropper",
		labelKey: "toolbar.eyedropperTool",
		icon: <Pipette size={20} />,
	},
	{
		tool: "select",
		labelKey: "toolbar.selectTool",
		icon: <MousePointer size={20} />,
	},
	{ tool: "path", labelKey: "toolbar.pathTool", icon: <PenTool size={20} /> },
	{
		tool: "path-edit",
		labelKey: "toolbar.pathEditTool",
		icon: <Route size={20} />,
	},
	{ tool: "shape", labelKey: "toolbar.shapeTool", icon: <Square size={20} /> },
	{ tool: "text", labelKey: "toolbar.textTool", icon: <Type size={20} /> },
	{
		tool: "bucket-fill",
		labelKey: "toolbar.bucketFillTool",
		icon: <PaintBucket size={20} />,
	},
	{
		tool: "gradient",
		labelKey: "toolbar.gradientTool",
		icon: (
			<div className="size-5 border rounded-sm border-current bg-[linear-gradient(to_right,var(--background),var(--foreground))]" />
		),
	},
];

export const ToolPane = memo(function ToolPane({
	state,
	onCommand,
}: {
	state: CompanionState;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();

	const handleToolClick = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const tool = e.currentTarget.dataset.tool as ToolType | undefined;
			if (tool) onCommand({ type: "setTool", tool });
		},
	);

	return (
		<div className="grid grid-cols-3 gap-2 p-3">
			{COMPANION_TOOLS.map(({ tool, labelKey, icon }) => (
				<button
					key={tool}
					type="button"
					data-tool={tool}
					onClick={handleToolClick}
					className={twm(
						"flex flex-col items-center justify-center gap-1 h-16 rounded-lg border transition-colors",
						tool === state.currentTool
							? "bg-accent text-accent-foreground border-accent"
							: "bg-muted/30 border-border",
					)}
				>
					{icon}
					<span className="text-[10px] leading-tight text-center px-1 truncate w-full">
						{t(labelKey)}
					</span>
				</button>
			))}
		</div>
	);
});
