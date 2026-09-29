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
import {
	dragStartThresholdScreenPx,
	LONG_PRESS_MS,
	type PointerEventData,
	type Tool,
} from "./Tool";
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
	/** Primary-button press waiting to become a click or a long press. */
	private press: {
		world: { x: number; y: number };
		startX: number;
		startY: number;
		timer: ReturnType<typeof setTimeout> | null;
	} | null = null;

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
		this.closeCandidates();

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

		if (event.button === 2) {
			this.openCandidates(world);
			return;
		}

		this.press = {
			world,
			startX: event.x,
			startY: event.y,
			timer: setTimeout(() => {
				this.press = null;
				this.openCandidates(world);
			}, LONG_PRESS_MS),
		};
	}

	public onPointerMove(
		event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (!this.press?.timer) return;
		const dist = Math.hypot(
			event.x - this.press.startX,
			event.y - this.press.startY,
		);
		// A press that wanders is still a click at where it began, just not a
		// long press.
		if (dist > dragStartThresholdScreenPx(event.pointerType)) {
			clearTimeout(this.press.timer);
			this.press.timer = null;
		}
	}

	public onPointerUp(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (!this.press) return;
		if (this.press.timer) clearTimeout(this.press.timer);
		this.pickAt(this.press.world);
		this.press = null;
	}

	public onCancel(): void {
		if (this.press?.timer) clearTimeout(this.press.timer);
		this.press = null;
		this.closeCandidates();
	}

	/** Apply a candidate listed by openCandidates and close the list. */
	public pickCandidate(elementId: string): void {
		const element = this.context.getElement(elementId);
		this.closeCandidates();
		if (element) this.pickElement(element);
	}

	public getCursor(): string {
		return "crosshair";
	}

	/**
	 * List every element painted at the point so the user can choose one.
	 * With nothing painted there, the backdrop is picked directly.
	 */
	private openCandidates(world: { x: number; y: number }): void {
		const hits = this.context.findPaintedElementsAtPoint(world.x, world.y);
		if (hits.length === 0) {
			this.pickAt(world);
			return;
		}

		this.context.uiSetToolSession({
			type: "eyedropper-candidates",
			point: world,
			candidates: hits.map((hit) => ({
				elementId: hit.element.id,
				depth: hit.depth,
			})),
		});
	}

	private closeCandidates(): void {
		this.context.uiSetToolSession(null);
	}

	/** Pick the frontmost painted element, or the backdrop when none is hit. */
	private pickAt(world: { x: number; y: number }): void {
		const target = this.context.findLeafElementAtPoint(world.x, world.y);
		if (target) {
			this.pickElement(target);
			return;
		}

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

	/** Copy the element's appearance onto the selection, or into tool settings. */
	private pickElement(target: AnyArtObject): void {
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length > 0) {
			this.callbacks.onPickForSelection(target, selectedIds);
			return;
		}

		const appearance = extractAppearance(target);
		this.callbacks.onPick({
			strokeAppearance: appearance.strokeAppearance,
			fillAppearance: appearance.fillAppearance,
		});
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
