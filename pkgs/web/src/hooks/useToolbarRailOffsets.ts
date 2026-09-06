import { useAppConfig } from "./useAppConfig";

/**
 * Offsets that keep a surface clear of the toolbar rail, shaped to spread onto
 * a `Drawer.Content`. Only the docked side gets an offset; the opposite edge of
 * the screen has no rail on it.
 */
export function useToolbarRailOffsets(): {
	leftOffset: string | number;
	rightOffset: string | number;
} {
	const { toolbarSide } = useAppConfig();

	return {
		leftOffset: toolbarSide === "left" ? "calc(3rem + var(--notch-left))" : 0,
		rightOffset:
			toolbarSide === "right" ? "calc(3rem + var(--notch-right))" : 0,
	};
}
