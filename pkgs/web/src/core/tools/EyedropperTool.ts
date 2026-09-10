import type {
	AnyArtObject,
	FillAppearance,
	StrokeAppearance,
	Viewport,
} from "../schema";
import {
	type ExtractedAppearance,
	extractAppearance,
} from "../utils/elementQuery";
import { screenToWorld } from "../utils/geometry/geometry";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

interface EyedropperPickData {
	strokeAppearance: StrokeAppearance | null;
	fillAppearance: FillAppearance | null;
	/** Solid color picked from empty area (artboard bg or black) */
	pickedColor?: ExtractedAppearance["pickedColor"];
}

interface EyedropperToolCallbacks {
	/** Pick appearance from target and apply to selected elements */
	onPickForSelection: (target: AnyArtObject, selectedIds: string[]) => void;
	/** Apply picked appearance to tool settings */
	onPick: (data: EyedropperPickData) => void;
}

export class EyedropperTool implements Tool {
	public readonly name = "eyedropper";

	private context: ToolContext;
	private callbacks: EyedropperToolCallbacks;

	public constructor(context: ToolContext, callbacks: EyedropperToolCallbacks) {
		this.context = context;
		this.callbacks = callbacks;
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (event.shiftKey) {
			this.pickPixelColor(event.x, event.y);
			return;
		}

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		const target = this.context.findElementAtPoint(world.x, world.y);
		const selectedIds = this.context.getSelectedElementIds();

		if (target && selectedIds.length > 0) {
			this.callbacks.onPickForSelection(target, selectedIds);
			return;
		}

		if (target) {
			const appearance = extractAppearance(target);
			this.callbacks.onPick({
				strokeAppearance: appearance.strokeAppearance,
				fillAppearance: appearance.fillAppearance,
			});
		} else {
			const artboard = this.context.findArtboardAtPoint(world.x, world.y);
			const bgColor = artboard?.backgroundColor ?? {
				type: "rgb" as const,
				r: 0,
				g: 0,
				b: 0,
				a: 1,
			};
			this.callbacks.onPick({
				strokeAppearance: null,
				fillAppearance: null,
				pickedColor: { type: "solid", color: bgColor },
			});
		}
	}

	public onPointerMove(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		// Hover highlight could be added here
	}

	public onPointerUp(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		// No-op
	}

	public onCancel(): void {
		// No-op
	}

	public getCursor(): string {
		return "crosshair";
	}

	private async pickPixelColor(
		screenX: number,
		screenY: number,
	): Promise<void> {
		const color = await this.context.pickPixelColor(screenX, screenY);
		if (!color) return;
		const solidColor = { type: "solid" as const, color };
		this.context.emitColorPick({
			strokeColor: solidColor,
			fillColor: solidColor,
			pixelPick: true,
		});
	}
}
