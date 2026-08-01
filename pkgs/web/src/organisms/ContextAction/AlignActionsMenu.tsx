import { Menu as BUIMenu } from "@base-ui/react/menu";
import {
	AlignCenterHorizontal,
	AlignCenterVertical,
	AlignEndHorizontal,
	AlignEndVertical,
	AlignHorizontalDistributeCenter,
	AlignHorizontalJustifyCenter,
	AlignStartHorizontal,
	AlignStartVertical,
	AlignVerticalDistributeCenter,
} from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** Alignment + distribution submenu for a multi-selection. */
export function AlignActionsMenu({
	selectedIds,
}: {
	selectedIds: readonly string[];
}) {
	const t = useTranslation();
	const paplico = usePaplico();

	// Distributing needs a middle element to move between the two extremes.
	const canDistribute = selectedIds.length >= 3;

	const handleAlignLeft = useEventCallback(() =>
		paplico.alignSelectedElements("left"),
	);
	const handleAlignCenterH = useEventCallback(() =>
		paplico.alignSelectedElements("centerH"),
	);
	const handleAlignRight = useEventCallback(() =>
		paplico.alignSelectedElements("right"),
	);
	const handleAlignTop = useEventCallback(() =>
		paplico.alignSelectedElements("top"),
	);
	const handleAlignCenterV = useEventCallback(() =>
		paplico.alignSelectedElements("centerV"),
	);
	const handleAlignBottom = useEventCallback(() =>
		paplico.alignSelectedElements("bottom"),
	);
	const handleDistributeHorizontal = useEventCallback(() =>
		paplico.distributeSelectedElements("horizontal"),
	);
	const handleDistributeVertical = useEventCallback(() =>
		paplico.distributeSelectedElements("vertical"),
	);

	return (
		<Menu.Root>
			<Tooltip content={t("contextActions.align")} side="bottom">
				<BUIMenu.Trigger
					render={
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							aria-label={t("contextActions.align")}
						>
							<AlignHorizontalJustifyCenter size={18} />
						</IconButton>
					}
				/>
			</Tooltip>
			<Menu.Portal>
				<Menu.Positioner side="bottom" align="start" sideOffset={4}>
					<Menu.Popup>
						<Menu.Item onClick={handleAlignLeft}>
							<AlignStartVertical size={14} />
							{t("contextActions.alignLeft")}
						</Menu.Item>
						<Menu.Item onClick={handleAlignCenterH}>
							<AlignCenterVertical size={14} />
							{t("contextActions.alignCenterH")}
						</Menu.Item>
						<Menu.Item onClick={handleAlignRight}>
							<AlignEndVertical size={14} />
							{t("contextActions.alignRight")}
						</Menu.Item>
						<Menu.Separator />
						<Menu.Item onClick={handleAlignTop}>
							<AlignStartHorizontal size={14} />
							{t("contextActions.alignTop")}
						</Menu.Item>
						<Menu.Item onClick={handleAlignCenterV}>
							<AlignCenterHorizontal size={14} />
							{t("contextActions.alignCenterV")}
						</Menu.Item>
						<Menu.Item onClick={handleAlignBottom}>
							<AlignEndHorizontal size={14} />
							{t("contextActions.alignBottom")}
						</Menu.Item>
						<Menu.Separator />
						<Menu.Item
							disabled={!canDistribute}
							onClick={handleDistributeHorizontal}
						>
							<AlignHorizontalDistributeCenter size={14} />
							{t("contextActions.distributeHorizontal")}
						</Menu.Item>
						<Menu.Item
							disabled={!canDistribute}
							onClick={handleDistributeVertical}
						>
							<AlignVerticalDistributeCenter size={14} />
							{t("contextActions.distributeVertical")}
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
