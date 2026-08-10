import { z } from "zod/mini";
import type { PressureCurvePoint } from "@/core/utils/pressureCurve";
import { IS_TAURI_ENV } from "@/utils/platform";
import { domAppConfig } from "./appConfig.dom";
import { tauriAppConfig } from "./appConfig.tauri";

export interface PersistedConfig {
	theme?: string;
	language?: string;
	lastDocumentId?: string | null;
	collaborationUserName?: string;
	defaultColorPickerMode?: string;
	shortcutOverrides?: unknown;
	toolbarSide?: string;
	panelLayout?: string;
	layerPanelMode?: string;
	filterMenuView?: string;
	selectStrokeAfterDraw?: boolean;
	pressureCurvePoints?: PressureCurvePoint[];
	touchDrawOffsetEnabled?: boolean;
	touchDrawOffsetScale?: number;
	selectSelectionMode?: string;
	pathEditSelectionMode?: string;
	maxZoomScale?: number;
}

export interface AppConfigRepo {
	load(): Promise<PersistedConfig>;
	save(config: PersistedConfig): Promise<void>;
}

export const appConfigRepo: AppConfigRepo = IS_TAURI_ENV
	? tauriAppConfig
	: domAppConfig;

const fallback = (schema: z.ZodMiniType) =>
	z.catch(schema, (ctx) => {
		console.warn(
			"[appConfig] field validation failed, using default",
			ctx.issues,
		);
		return undefined;
	});

const configSchema = z.object({
	theme: fallback(z.optional(z.string())),
	language: fallback(z.optional(z.string())),
	lastDocumentId: fallback(z.optional(z.nullable(z.string()))),
	collaborationUserName: fallback(z.optional(z.string())),
	defaultColorPickerMode: fallback(z.optional(z.string())),
	shortcutOverrides: fallback(z.optional(z.unknown())),
	toolbarSide: fallback(z.optional(z.string())),
	panelLayout: fallback(z.optional(z.string())),
	layerPanelMode: fallback(z.optional(z.string())),
	filterMenuView: fallback(z.optional(z.string())),
	selectStrokeAfterDraw: fallback(z.optional(z.boolean())),
	pressureCurvePoints: fallback(
		z.optional(z.array(z.object({ x: z.number(), y: z.number() }))),
	),
	touchDrawOffsetEnabled: fallback(z.optional(z.boolean())),
	touchDrawOffsetScale: fallback(z.optional(z.number())),
	selectSelectionMode: fallback(z.optional(z.string())),
	pathEditSelectionMode: fallback(z.optional(z.string())),
	maxZoomScale: fallback(z.optional(z.number())),
});

export function parsePersistedConfig(raw: unknown): PersistedConfig {
	const result = configSchema.safeParse(raw);
	return (result.success ? result.data : {}) as PersistedConfig;
}
