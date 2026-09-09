import { BoxSelect, LassoSelect, Merge, Scissors, Split } from "lucide-react";
import { type ComponentProps, memo, useMemo } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { ToggleGroup } from "@/components/ToggleGroup";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { appConfig } from "@/hooks/useAppConfig";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const PathEditToolControls = memo(function PathEditToolControls() {
	const t = useTranslation();
	const { tools, commands } = usePaplico();
	const toolSnap = useSnapshot(tools.state);

	const selectionMode = toolSnap.pathEditSelectionMode;
	const selectedAnchors = toolSnap.pathEditSelectedAnchors;

	const handleSelectionModeChange = useEventCallback((value: string[]) => {
		if (value.length > 0) {
			const mode = value[0] as "lasso" | "rectangle";
			tools.setPathEditSelectionMode(mode);
			appConfig.pathEditSelectionMode = mode;
		}
	});

	const { canMerge, canSplit } = useMemo(() => {
		if (selectedAnchors.length === 0)
			return { canMerge: false, canSplit: false };

		// Merge: exactly 2 endpoints. Two paths join into one; one path closes.
		const endpoints = selectedAnchors.filter((a) => a.isEndpoint);
		const mergeEnabled = endpoints.length === 2;

		// Split: exactly 1 non-endpoint anchor
		const nonEndpoints = selectedAnchors.filter((a) => !a.isEndpoint);
		const splitEnabled = nonEndpoints.length === 1;

		return { canMerge: mergeEnabled, canSplit: splitEnabled };
	}, [selectedAnchors]);

	const handleMerge = useEventCallback(() => {
		const endpoints = selectedAnchors.filter((a) => a.isEndpoint);
		if (endpoints.length !== 2) return;

		const [a, b] = endpoints;
		if (a.pathId === b.pathId) {
			commands.closePath(a.pathId);
		} else {
			const endpointA =
				a.segmentIndex === 0 && a.pointType === "start" ? "start" : "end";
			const endpointB =
				b.segmentIndex === 0 && b.pointType === "start" ? "start" : "end";
			commands.mergePaths(a.pathId, endpointA, b.pathId, endpointB);
		}

		// Reset tool state: the joined path replaced the selected paths,
		// so selectedPaths/selectedHandles are stale.
		tools.getCurrentTool()?.onCancel();
	});

	const handleSplit = useEventCallback(() => {
		const nonEndpoints = selectedAnchors.filter((a) => !a.isEndpoint);
		if (nonEndpoints.length !== 1) return;

		const anchor = nonEndpoints[0];
		commands.splitPathAtAnchor(
			anchor.pathId,
			anchor.segmentIndex,
			anchor.pointType,
		);

		// Reset tool state: the original path is split into two,
		// so selectedPaths/selectedHandles are stale.
		tools.getCurrentTool()?.onCancel();
	});

	return (
		<div className="flex flex-col gap-2 w-full">
			<div className="flex flex-col gap-1">
				<span className="text-[10px] text-muted-foreground">
					{t("actionsPanel.pathEditSelectionMode")}
				</span>
				<ToggleGroup.Root
					value={[selectionMode]}
					onValueChange={handleSelectionModeChange}
				>
					<ToggleGroup.Item
						value="rectangle"
						className="h-5 w-auto px-1.5 text-[10px] gap-0.5"
					>
						<BoxSelect size={12} />
						{t("actionsPanel.pathEditRectangle")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="lasso"
						className="h-5 w-auto px-1.5 text-[10px] gap-0.5"
					>
						<LassoSelect size={12} />
						{t("actionsPanel.pathEditLasso")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

			<div className="flex gap-1">
				<Tooltip content={t("actionsPanel.pathEditMerge")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						disabled={!canMerge}
						onClick={handleMerge}
					>
						<Merge size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.pathEditSplit")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						disabled={!canSplit}
						onClick={handleSplit}
					>
						<Split size={14} />
					</IconButton>
				</Tooltip>
				<PathEditCutModeToggle />
			</div>
		</div>
	);
});

/**
 * Cut mode toggle: arms the next canvas click to cut the path under it.
 * Shared between the path edit panel and the context actions bar.
 */
export function PathEditCutModeToggle({
	$size = "xs",
}: {
	$size?: ComponentProps<typeof IconButton>["$size"];
}) {
	const t = useTranslation();
	const { tools } = usePaplico();
	const cutMode = useSnapshot(tools.state).pathEditCutMode;

	const handleToggle = useEventCallback(() => {
		tools.setPathEditCutMode(!cutMode);
	});

	return (
		<Tooltip content={t("actionsPanel.pathEditCutMode")} side="bottom">
			<IconButton
				$size={$size}
				$variant="ghost"
				$pressed={cutMode}
				onClick={handleToggle}
			>
				<Scissors size={CUT_ICON_SIZE[$size]} />
			</IconButton>
		</Tooltip>
	);
}

const CUT_ICON_SIZE = { xs: 14, sm: 16, md: 18, lg: 20 } as const;
