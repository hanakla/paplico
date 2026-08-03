import {
	mergeBrushSettingsV2PreservingCurves,
	normalizeBrushSettingsV2,
} from "./brush/migrate";
import { normalizeBrushSettings } from "./brush/normalize";
import { createStrokeBrushSettings } from "./document/factory";
import {
	type BrushSettings,
	type BrushSettingsPatch,
	type BrushSettingsV2,
	cloneAppearance,
	type FillAppearance,
	type FillColor,
	generateUid,
	type StrokeAppearance,
	type StrokeColor,
} from "./schema";
import type { Tool } from "./tools/Tool";
import {
	type BucketFillLeakState,
	MAX_TOUCH_DRAW_OFFSET_SCALE,
	type ShapeType,
	type SmoothingMethod,
	type ToolSettings,
	type ToolType,
} from "./tools/toolSettings";
import {
	type PressureCurvePoint,
	sanitizePressureCurvePoints,
} from "./utils/pressureCurve";

type ToolsAPI = {
	getCurrentTool: () => Tool | null;
};

/**
 * ToolSettings mutation boundary.
 * Keeps cross-tool invariants in one place (e.g. reset gradient stop selection on tool switch).
 */
export class PaplicoTools {
	private readonly store: ToolSettings;
	private api: ToolsAPI;

	public constructor(store: ToolSettings, api: ToolsAPI) {
		this.store = store;
		this.api = api;
	}

	public get state(): ToolSettings {
		return this.store;
	}

	// --- Convenience accessors ---

	public get strokeColor(): StrokeColor | null {
		return this.store.strokeAppearance?.paramData.params.strokeColor ?? null;
	}

	public get fillColor(): FillColor | null {
		return this.store.fillAppearance?.paramData.params.fill ?? null;
	}

	public get brushSettings(): BrushSettings {
		const raw = this.store.strokeAppearance?.paramData.params.brushSettings;
		return raw != null
			? normalizeBrushSettings(raw)
			: createStrokeBrushSettings(2);
	}

	/**
	 * Stored brush settings in their persisted format (v2 after any edit).
	 * Persistence paths (preset save) read this so curve-editor state
	 * survives; UI edits go through the legacy view via `brushSettings`.
	 */
	public get storedBrushSettings(): BrushSettings | BrushSettingsV2 {
		return (
			this.store.strokeAppearance?.paramData.params.brushSettings ??
			createStrokeBrushSettings(2)
		);
	}

	// --- Mutations ---

	public setStrokeColor(color: StrokeColor | null): void {
		if (!color) {
			this.store.strokeAppearance = null;
			return;
		}

		if (!this.store.strokeAppearance) {
			// Restore default strokeAppearance with the given color
			this.store.strokeAppearance = {
				uid: generateUid("app"),
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: color,
						brushSettings: createStrokeBrushSettings(2),
					},
				},
			};
			return;
		}

		this.store.strokeAppearance = cloneAppearance(this.store.strokeAppearance, {
			strokeColor: color,
		});
	}

	public getCurrentTool(): Tool | null {
		return this.api.getCurrentTool();
	}

	public setCurrentTool(tool: ToolType): void {
		if (this.store.currentTool !== tool) {
			this.store.gradientSelectedStopId = null;
			this.store.gradientSelectedStopIndex = null;
		}
		this.store.currentTool = tool;
	}

	public setBrushSettings(patch: BrushSettingsPatch | BrushSettingsV2): void {
		if (!this.store.strokeAppearance) return;

		let updated: BrushSettingsV2;
		if ("version" in patch && patch.version === 2) {
			// A complete v2 value (preset application) replaces the stored
			// settings wholesale — no state is carried over.
			updated = normalizeBrushSettingsV2(patch);
		} else {
			const stored = this.store.strokeAppearance.paramData.params.brushSettings;
			const previous =
				stored != null ? normalizeBrushSettingsV2(stored) : undefined;
			// Flat (v1-shaped) patches merge onto the legacy view (same brush
			// type; a patch carrying a different `type` is a full replacement),
			// then the result is rebuilt as v2. Curve-editor state the flat layer
			// cannot express is carried over from the previously stored v2 value.
			const merged = { ...this.brushSettings, ...patch };
			updated = mergeBrushSettingsV2PreservingCurves(
				previous,
				normalizeBrushSettingsV2(merged),
			);
		}
		this.store.strokeAppearance = cloneAppearance(this.store.strokeAppearance, {
			brushSettings: updated,
		});
	}

	public setSvgBrush(): void {
		this.setBrushSettings(createStrokeBrushSettings(this.brushSettings.size));
	}

	public setFillColor(color: FillColor | null): void {
		if (!color) {
			this.store.fillAppearance = null;
			return;
		}

		this.store.fillAppearance = this.store.fillAppearance
			? cloneAppearance(this.store.fillAppearance, { fill: color })
			: {
					uid: generateUid("app"),
					processor: "fill",
					opacity: 1,
					blendMode: "normal",
					paramData: { version: "1", params: { fill: color } },
				};
	}

	public setStrokeAppearance(appearance: StrokeAppearance): void {
		this.store.strokeAppearance = appearance;
	}

	public setFillAppearance(appearance: FillAppearance | null): void {
		this.store.fillAppearance = appearance;
	}

	public setShapeType(shapeType: ShapeType): void {
		this.store.shapeType = shapeType;
	}

	public swapColors(): void {
		const prevStrokeColor = this.strokeColor;
		const prevFillColor = this.fillColor;

		// Fill → Stroke (skip if fill is null — stroke must always have a color)
		const newStrokeColor = fillColorToStrokeColor(prevFillColor);
		if (newStrokeColor) {
			this.setStrokeColor(newStrokeColor);
		}

		// Stroke → Fill
		this.setFillColor(strokeColorToFillColor(prevStrokeColor));
	}

	public setGradientSelectedStopId(id: string | null): void {
		this.store.gradientSelectedStopId = id;
	}

	public setGradientSelectedStopIndex(index: number | null): void {
		this.store.gradientSelectedStopIndex = index;
	}

	public setBucketFillLeaks(state: BucketFillLeakState | null): void {
		this.store.bucketFillLeaks = state;
	}

	public setBucketFillComputing(computing: boolean): void {
		this.store.bucketFillComputing = computing;
	}

	public setBucketFillGapClosing(radius: number): void {
		this.store.bucketFillGapClosing = radius;
	}

	public setBucketFillTolerance(value: number): void {
		this.store.bucketFillTolerance = value;
	}

	public setEraserSize(size: number): void {
		this.store.eraserSize = size;
	}

	public setEraserPierceAllLayers(enabled: boolean): void {
		this.store.eraserPierceAllLayers = enabled;
	}

	public setStabilization(value: number): void {
		this.store.stabilization = Math.max(0, Math.min(1, value));
	}

	public setOpacity(value: number): void {
		this.store.opacity = Math.max(0, Math.min(1, value));
	}

	public setPressureCurve(points: readonly PressureCurvePoint[]): void {
		// Sanitize always returns a fresh array with fresh point objects, which
		// keys the pressure LUT cache correctly and breaks valtio aliasing.
		this.store.pressureCurvePoints = sanitizePressureCurvePoints(points);
	}

	public setTouchDrawOffsetScale(scale: number): void {
		this.store.touchDrawOffsetScale = Math.max(
			0,
			Math.min(MAX_TOUCH_DRAW_OFFSET_SCALE, scale),
		);
	}

	public setSmoothingMethod(method: SmoothingMethod): void {
		this.store.smoothingMethod = method;
	}

	public setPathEditSelectionMode(mode: "lasso" | "rectangle"): void {
		this.store.pathEditSelectionMode = mode;
	}

	public setPathEditCutMode(enabled: boolean): void {
		this.store.pathEditCutMode = enabled;
	}

	public setSelectSelectionMode(mode: "lasso" | "rectangle"): void {
		this.store.selectSelectionMode = mode;
	}
}

function fillColorToStrokeColor(fill: FillColor | null): StrokeColor | null {
	if (!fill) return null;
	if (fill.type === "solid") return fill;
	if (fill.type === "linear")
		return { type: "stroke-gradient", gradient: fill, mode: "within" };
	if (fill.type === "mesh") {
		return fill.vertices.length > 0
			? { type: "solid", color: fill.vertices[0].color }
			: null;
	}
	if (fill.type === "free") {
		return fill.stops.length > 0
			? { type: "solid", color: fill.stops[0].color }
			: null;
	}
	if (fill.type === "pattern") {
		return { type: "stroke-pattern", pattern: fill, mode: "within" };
	}
	// RadialGradient → use first stop as solid
	return fill.stops.length > 0
		? { type: "solid", color: fill.stops[0].color }
		: null;
}

function strokeColorToFillColor(stroke: StrokeColor | null): FillColor | null {
	if (!stroke) return null;
	if (stroke.type === "solid") return stroke;
	if (stroke.type === "stroke-pattern") return stroke.pattern;
	return stroke.gradient;
}
