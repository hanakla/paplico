import { Drawer } from "@/components/Drawer";
import { Icons } from "@/components/Icons";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { ActionsPanel } from "@/organisms/ActionsPanel";
import { FilterPanel } from "@/organisms/FilterPanel";
import { LayerPanel } from "@/organisms/LayerPanel";
import { setMobilePanelOpen, useUIState } from "@/stores/uiStore";
import { twm } from "@/utils/tailwind";

type PanelKey = "context" | "layers" | "filters";

const PANEL_ICONS: Record<PanelKey, React.ComponentType<{ size: number }>> = {
	context: Icons.ActionsPanel,
	layers: Icons.Layer,
	filters: Icons.Appearance,
};

export function MobilePanels() {
	const layoutMode = useLayoutMode();
	const { toolbarSide, panelLayout } = useAppConfig();
	const uiSnap = useUIState();

	// Null is "not decided yet", which is neither desktop nor mobile: rendering
	// the mobile surfaces on it puts them on a desktop for one frame, which is
	// the mismatch the desktop bar avoids by testing the other way round.
	if (layoutMode !== "portrait" && layoutMode !== "landscape-compact") {
		return null;
	}

	const drawerMode = layoutMode === "portrait" ? "bottom" : "side";
	const drawerSide =
		panelLayout === "split"
			? toolbarSide === "left"
				? "right"
				: "left"
			: toolbarSide;
	const swipeDirection: React.ComponentProps<
		typeof Drawer.Root
	>["swipeDirection"] =
		drawerMode === "bottom" ? "down" : drawerSide === "left" ? "left" : "right";
	const isOpen = uiSnap.mobilePanelOpen !== null;

	return (
		<>
			{/* Tab bar */}
			<div
				className={twm(
					"fixed pointer-events-auto",
					layoutMode === "portrait"
						? [
								"bottom-0 h-(--mobile-tab-bar-height) flex flex-row items-center justify-around bg-background/80 backdrop-blur-sm border-t border-border pb-safe-bottom",
								toolbarSide === "left"
									? "left-[calc(3rem+var(--notch-left))] right-0"
									: "left-0 right-[calc(3rem+var(--notch-right))]",
							]
						: [
								"top-2 flex flex-col gap-1 bg-background/80 backdrop-blur-sm rounded-xl p-1 border border-border",
								panelLayout === "split"
									? toolbarSide === "left"
										? "right-2"
										: "left-[calc(3.5rem+var(--notch-left))]"
									: toolbarSide === "left"
										? "left-[calc(3.5rem+var(--notch-left))]"
										: "right-[calc(3.5rem+var(--notch-right))]",
							],
				)}
			>
				{(["context", "layers", "filters"] as const).map((panel) => {
					const Icon = PANEL_ICONS[panel];
					return (
						<button
							key={panel}
							type="button"
							className={twm(
								"p-1.5 rounded-lg transition-colors",
								uiSnap.mobilePanelOpen === panel
									? "bg-accent text-accent-foreground"
									: "text-muted-foreground hover:text-foreground hover:bg-accent/50",
							)}
							onClick={() =>
								setMobilePanelOpen(
									uiSnap.mobilePanelOpen === panel ? null : panel,
								)
							}
						>
							<Icon size={16} />
						</button>
					);
				})}
			</div>

			{/* Drawer */}
			<Drawer.Root
				open={isOpen}
				modal={false}
				swipeDirection={swipeDirection}
				disablePointerDismissal
				onOpenChange={(open) => !open && setMobilePanelOpen(null)}
			>
				<Drawer.Content
					modal={false}
					mode={drawerMode}
					side={drawerSide}
					bottomOffset={
						drawerMode === "bottom" ? "var(--mobile-tab-bar-height)" : 0
					}
				>
					<div className="flex-1 flex flex-col min-h-0 [&>div]:w-full! [&>div]:max-h-none! [&>div]:flex-1! [&>div]:rounded-none! [&>div]:shadow-none! [&>div]:bg-transparent! [&>div]:backdrop-filter-none!">
						{uiSnap.mobilePanelOpen === "context" && <ActionsPanel />}
						{uiSnap.mobilePanelOpen === "layers" && <LayerPanel />}
						{uiSnap.mobilePanelOpen === "filters" && <FilterPanel />}
					</div>
				</Drawer.Content>
			</Drawer.Root>
		</>
	);
}
