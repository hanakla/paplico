import {
	createContext,
	memo,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import { Drawer } from "@/components/Drawer";
import { Popover } from "@/components/Popover";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useToolbarRailOffsets } from "@/hooks/useToolbarRailOffsets";
import { useEventCallback } from "@/utils/hooks";

type AppearanceSurfaceContextValue = {
	open: boolean;
	isSheet: boolean;
	onOpenChange?: (open: boolean) => void;
	onSheetDismiss?: () => void;
};

/**
 * Surface that holds appearance settings: a popover beside the panel where
 * there is room for it, a sheet rising from the bottom edge in portrait, where
 * a 16rem popover has nowhere to go next to a 13rem panel.
 *
 * Mirrors `Popover`'s Root / Trigger / Content shape so call sites keep their
 * existing markup.
 */
export const AppearanceSurface = {
	Root: memo(AppearanceSurfaceRoot),
	Trigger: memo(AppearanceSurfaceTrigger),
	Content: memo(AppearanceSurfaceContent),
};

const AppearanceSurfaceContext =
	createContext<AppearanceSurfaceContextValue | null>(null);

function AppearanceSurfaceRoot({
	open,
	onOpenChange,
	onSheetDismiss,
	children,
}: {
	open: boolean;
	/** Open state of both surfaces. Leave out to keep the popover uncontrolled. */
	onOpenChange?: (open: boolean) => void;
	/** Swipe-down dismissal, for call sites that own the popover's open state. */
	onSheetDismiss?: () => void;
	children: ReactNode;
}) {
	const isSheet = useLayoutMode() === "portrait";

	const value = useMemo(
		() => ({ open, isSheet, onOpenChange, onSheetDismiss }),
		[open, isSheet, onOpenChange, onSheetDismiss],
	);

	return (
		<AppearanceSurfaceContext.Provider value={value}>
			{isSheet ? (
				children
			) : (
				<Popover.Root open={open} onOpenChange={onOpenChange}>
					{children}
				</Popover.Root>
			)}
		</AppearanceSurfaceContext.Provider>
	);
}

/**
 * The row that opens the surface. A sheet needs no anchor, so in portrait the
 * row renders as-is and its own click handler keeps driving the open state.
 */
function AppearanceSurfaceTrigger({ children }: { children: ReactNode }) {
	const { isSheet } = useAppearanceSurfaceContext();

	if (isSheet) return children;

	return <Popover.Trigger>{children}</Popover.Trigger>;
}

function AppearanceSurfaceContent({
	title,
	children,
}: {
	/** Sheet-only heading. The sheet covers the row it came from, so without it
	 *  there is nothing left on screen naming what is being edited. */
	title?: ReactNode;
	children: ReactNode;
}) {
	const { open, isSheet } = useAppearanceSurfaceContext();
	const railOffsets = useToolbarRailOffsets();
	const close = useAppearanceSurfaceClose();

	const handleOpenChange = useEventCallback((next: boolean) => {
		if (!next) close();
	});

	if (!isSheet) {
		return (
			<Popover.Content side="left" sideOffset={8} className="min-w-64 p-3">
				{children}
			</Popover.Content>
		);
	}

	return (
		<Drawer.Root
			open={open}
			modal={false}
			swipeDirection="down"
			disablePointerDismissal
			onOpenChange={handleOpenChange}
		>
			<Drawer.Content
				modal={false}
				mode="bottom"
				bottomOffset="var(--mobile-tab-bar-height)"
				{...railOffsets}
			>
				{title && (
					<div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 pb-2 text-foreground text-xs font-medium">
						{title}
					</div>
				)}
				<div className="flex-1 min-h-0 overflow-y-auto p-3">{children}</div>
			</Drawer.Content>
		</Drawer.Root>
	);
}

/**
 * Closes the enclosing surface. For controls inside the content that finish a
 * task somewhere else, such as handing a brush over to the designer.
 */
export function useAppearanceSurfaceClose() {
	const { onOpenChange, onSheetDismiss } = useAppearanceSurfaceContext();

	return useEventCallback(() => {
		onOpenChange?.(false);
		onSheetDismiss?.();
	});
}

function useAppearanceSurfaceContext() {
	const value = useContext(AppearanceSurfaceContext);

	if (!value) {
		throw new Error(
			"AppearanceSurface.Trigger / .Content must be used within AppearanceSurface.Root",
		);
	}

	return value;
}
