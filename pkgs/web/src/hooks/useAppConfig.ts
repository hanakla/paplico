import { proxy, subscribe, useSnapshot } from "valtio";
import type { ShortcutsConfig } from "@/core/PaplicoShortcuts";
import { MAX_TOUCH_DRAW_OFFSET_SCALE } from "@/core/tools/toolSettings";
import {
	DEFAULT_PRESSURE_CURVE,
	type PressureCurvePoint,
	sanitizePressureCurvePoints,
} from "@/core/utils/pressureCurve";
import { appConfigRepo } from "@/repos/appConfig";

export type Theme =
	| "dark"
	| "light"
	| "system"
	| "pink"
	| "lime"
	| "purple"
	| "black"
	| "white";
export type Language = "ja" | "en";
export type ToolbarSide = "left" | "right";
export type PanelLayout = "together" | "split";
export type LayerPanelMode = "simple" | "detailed";
export type FilterMenuView = "category" | "list";

interface AppConfig {
	theme: Theme;
	language: Language;
	lastDocumentId: string | null;
	collaborationUserName: string;
	/**
	 * Reserved for future use. Color picker mode is now determined by the color type,
	 * so this field is not actively used.
	 */
	defaultColorPickerMode: "rgba" | "hsla";
	/** User-customized shortcut keybinding overrides (null = use defaults) */
	shortcutOverrides: ShortcutsConfig | null;
	/** Which side of the canvas the toolbar is displayed on */
	toolbarSide: ToolbarSide;
	/** Whether side panels are grouped together or spread across both sides */
	panelLayout: PanelLayout;
	/** Layer panel display mode: simple shows only layers, detailed shows elements too */
	layerPanelMode: LayerPanelMode;
	/** Add-filter menu display: category submenus or a flat list */
	filterMenuView: FilterMenuView;
	/** Whether to auto-select the stroke after drawing */
	selectStrokeAfterDraw: boolean;
	/** Control points mapping raw pen pressure to effective pressure */
	pressureCurvePoints: PressureCurvePoint[];
	/** Draw above the fingertip on touch input (brush and eraser tools) */
	touchDrawOffsetEnabled: boolean;
	/** How far above the fingertip to draw, as a multiplier on the contact width */
	touchDrawOffsetScale: number;
	/** Selection mode for the Select tool: lasso or rectangle marquee */
	selectSelectionMode: "lasso" | "rectangle";
	/** Selection mode for the PathEdit tool: lasso or rectangle marquee */
	pathEditSelectionMode: "lasso" | "rectangle";
}

function detectDefaultLanguage(): Language {
	if (typeof navigator === "undefined") return "en";
	return navigator.language.startsWith("ja") ? "ja" : "en";
}

function resolveSystemDark(): boolean {
	if (typeof matchMedia === "undefined") return false;
	return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyThemeToDOM(theme: Theme): void {
	if (typeof document === "undefined") return;

	const html = document.documentElement;
	html.classList.remove(
		"dark",
		"light",
		"pink",
		"lime",
		"purple",
		"black",
		"white",
	);

	switch (theme) {
		case "dark": {
			html.classList.add("dark");
			return;
		}
		case "light": {
			html.classList.add("light");
			return;
		}
		case "pink": {
			html.classList.add("pink");
			return;
		}
		case "lime": {
			html.classList.add("lime");
			return;
		}
		case "purple": {
			html.classList.add("purple");
			return;
		}
		case "black": {
			html.classList.add("black");
			return;
		}
		case "white": {
			html.classList.add("white");
			return;
		}
		case "system": {
			// system: media queryで判定してclassを付与
			if (resolveSystemDark()) {
				html.classList.add("dark");
			}
			// lightの場合はclass不要（:rootがライト）
			return;
		}
	}
}

// --- Valtio Store ---

export const appConfig = proxy<AppConfig>({
	theme: "system",
	language: detectDefaultLanguage(),
	lastDocumentId: null,
	collaborationUserName: "",
	defaultColorPickerMode: "rgba",
	shortcutOverrides: null,
	toolbarSide: "left",
	panelLayout: "together",
	layerPanelMode: "simple",
	filterMenuView: "category",
	selectStrokeAfterDraw: true,
	pressureCurvePoints: [...DEFAULT_PRESSURE_CURVE],
	touchDrawOffsetEnabled: true,
	touchDrawOffsetScale: 1,
	selectSelectionMode: "rectangle",
	pathEditSelectionMode: "rectangle",
});

// Persist and apply theme on every change
subscribe(appConfig, () => {
	void appConfigRepo.save({
		theme: appConfig.theme,
		language: appConfig.language,
		lastDocumentId: appConfig.lastDocumentId,
		collaborationUserName: appConfig.collaborationUserName,
		defaultColorPickerMode: appConfig.defaultColorPickerMode,
		shortcutOverrides: appConfig.shortcutOverrides,
		toolbarSide: appConfig.toolbarSide,
		panelLayout: appConfig.panelLayout,
		layerPanelMode: appConfig.layerPanelMode,
		filterMenuView: appConfig.filterMenuView,
		selectStrokeAfterDraw: appConfig.selectStrokeAfterDraw,
		pressureCurvePoints: appConfig.pressureCurvePoints.map((p) => ({ ...p })),
		touchDrawOffsetEnabled: appConfig.touchDrawOffsetEnabled,
		touchDrawOffsetScale: appConfig.touchDrawOffsetScale,
		selectSelectionMode: appConfig.selectSelectionMode,
		pathEditSelectionMode: appConfig.pathEditSelectionMode,
	});
	applyThemeToDOM(appConfig.theme);
});

// --- Setters ---

export function setTheme(theme: Theme): void {
	appConfig.theme = theme;
}

export function setLanguage(language: Language): void {
	appConfig.language = language;
}

export function setCollaborationUserName(name: string): void {
	appConfig.collaborationUserName = name;
}

export function setToolbarSide(side: ToolbarSide): void {
	appConfig.toolbarSide = side;
}

export function setPanelLayout(layout: PanelLayout): void {
	appConfig.panelLayout = layout;
}

export function setLayerPanelMode(mode: LayerPanelMode): void {
	appConfig.layerPanelMode = mode;
}

export function setFilterMenuView(view: FilterMenuView): void {
	appConfig.filterMenuView = view;
}

export function setLastDocumentId(id: string | null): void {
	appConfig.lastDocumentId = id;
}

export function setShortcutOverrides(config: ShortcutsConfig | null): void {
	appConfig.shortcutOverrides = config;
}

export function setPressureCurvePoints(
	points: readonly PressureCurvePoint[],
): void {
	appConfig.pressureCurvePoints = sanitizePressureCurvePoints(points);
}

export function setTouchDrawOffsetEnabled(enabled: boolean): void {
	appConfig.touchDrawOffsetEnabled = enabled;
}

export function setTouchDrawOffsetScale(scale: number): void {
	appConfig.touchDrawOffsetScale = Math.max(
		0,
		Math.min(MAX_TOUCH_DRAW_OFFSET_SCALE, scale),
	);
}

/** Offset scale handed to the engine: 0 while the feature is switched off */
export function resolveTouchDrawOffsetScale(): number {
	return appConfig.touchDrawOffsetEnabled ? appConfig.touchDrawOffsetScale : 0;
}

// --- Init ---

let initialized = false;
let mediaQueryCleanup: (() => void) | null = null;

export async function initAppConfig(): Promise<void> {
	if (initialized) return;
	initialized = true;

	const stored = await appConfigRepo.load();

	// Apply persisted values over defaults (only fields present in stored config)
	if (stored.theme !== undefined) appConfig.theme = stored.theme as Theme;
	if (stored.language !== undefined)
		appConfig.language = stored.language as Language;
	if (stored.lastDocumentId !== undefined)
		appConfig.lastDocumentId = stored.lastDocumentId;
	if (stored.collaborationUserName !== undefined)
		appConfig.collaborationUserName = stored.collaborationUserName;
	if (stored.shortcutOverrides !== undefined)
		appConfig.shortcutOverrides =
			stored.shortcutOverrides as ShortcutsConfig | null;
	if (stored.toolbarSide !== undefined)
		appConfig.toolbarSide = stored.toolbarSide as ToolbarSide;
	if (stored.panelLayout !== undefined)
		appConfig.panelLayout = stored.panelLayout as PanelLayout;
	if (stored.layerPanelMode !== undefined)
		appConfig.layerPanelMode = stored.layerPanelMode as LayerPanelMode;
	if (stored.filterMenuView !== undefined)
		appConfig.filterMenuView = stored.filterMenuView as FilterMenuView;
	if (stored.selectStrokeAfterDraw !== undefined)
		appConfig.selectStrokeAfterDraw = stored.selectStrokeAfterDraw;
	if (stored.pressureCurvePoints !== undefined)
		appConfig.pressureCurvePoints = sanitizePressureCurvePoints(
			stored.pressureCurvePoints,
		);
	if (stored.touchDrawOffsetEnabled !== undefined)
		appConfig.touchDrawOffsetEnabled = stored.touchDrawOffsetEnabled;
	if (stored.touchDrawOffsetScale !== undefined)
		appConfig.touchDrawOffsetScale = Math.max(
			0,
			Math.min(MAX_TOUCH_DRAW_OFFSET_SCALE, stored.touchDrawOffsetScale),
		);
	if (stored.selectSelectionMode !== undefined)
		appConfig.selectSelectionMode = stored.selectSelectionMode as
			| "lasso"
			| "rectangle";
	if (stored.pathEditSelectionMode !== undefined)
		appConfig.pathEditSelectionMode = stored.pathEditSelectionMode as
			| "lasso"
			| "rectangle";

	applyThemeToDOM(appConfig.theme);
	listenSystemThemeChange();
}

function listenSystemThemeChange(): void {
	if (typeof matchMedia === "undefined") return;

	mediaQueryCleanup?.();

	const mq = matchMedia("(prefers-color-scheme: dark)");
	const handler = () => {
		if (appConfig.theme === "system") {
			applyThemeToDOM("system");
		}
	};

	mq.addEventListener("change", handler);
	mediaQueryCleanup = () => mq.removeEventListener("change", handler);
}

// --- Hook ---

export function useAppConfig() {
	return useSnapshot(appConfig);
}
