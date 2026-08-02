import { Plus } from "lucide-react";
import { memo, useState } from "react";
import { Drawer } from "@/components/Drawer";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useEventCallback } from "@/utils/hooks";
import { AddFilterMenu } from "./AddFilterMenu";
import { AddFilterSheet } from "./AddFilterSheet";

/**
 * "+" button offering the filter catalog: a dropdown beside the panel where
 * there is room for one, a sheet from the bottom edge in portrait.
 */
export const AddFilterButton = memo(function AddFilterButton({
	isSubFilter,
	onAdd,
	side,
	iconSize,
}: {
	isSubFilter: boolean;
	onAdd: (processor: string, asSubFilter: boolean) => void;
	/** Which way the dropdown opens. The sheet ignores it. */
	side: "left" | "right";
	iconSize: number;
}) {
	const isSheet = useLayoutMode() === "portrait";
	const [sheetOpen, setSheetOpen] = useState(false);

	const handleOpenSheet = useEventCallback(() => {
		setSheetOpen(true);
	});

	const handleAddFromSheet = useEventCallback(
		(processor: string, asSubFilter: boolean) => {
			setSheetOpen(false);
			onAdd(processor, asSubFilter);
		},
	);

	if (!isSheet) {
		return (
			<Menu.Root highlightItemOnHover={false}>
				<Menu.Trigger className="p-0 hover:bg-transparent data-popup-open:bg-transparent">
					<IconButton $size="xs" $variant="ghost">
						<Plus size={iconSize} />
					</IconButton>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner side={side} sideOffset={4}>
						<Menu.Popup>
							<AddFilterMenu isSubFilter={isSubFilter} onAdd={onAdd} />
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		);
	}

	return (
		<>
			<IconButton $size="xs" $variant="ghost" onClick={handleOpenSheet}>
				<Plus size={iconSize} />
			</IconButton>
			<Drawer.Root
				open={sheetOpen}
				modal={false}
				swipeDirection="down"
				disablePointerDismissal
				onOpenChange={setSheetOpen}
			>
				<Drawer.Content
					modal={false}
					mode="bottom"
					bottomOffset="var(--mobile-tab-bar-height)"
					className="max-h-[50dvh]"
				>
					<AddFilterSheet
						isSubFilter={isSubFilter}
						onAdd={handleAddFromSheet}
					/>
				</Drawer.Content>
			</Drawer.Root>
		</>
	);
});
