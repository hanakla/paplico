import {
	KeyboardSensor,
	type Modifier,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/** The host's layer panel sensor set (LayerPanel.tsx, useLayerPanelSensors): a
 *  drag needs either a few pixels of mouse travel or a short press, so a plain
 *  tap still selects and a flick still scrolls the list. */
export function useCompanionSortSensors() {
	return useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
}

const restrictToVertical: Modifier = ({ transform }) => ({
	...transform,
	x: 0,
});

/** Both companion lists sort one kind of row along one axis. */
export const DND_MODIFIERS = [restrictToVertical];
