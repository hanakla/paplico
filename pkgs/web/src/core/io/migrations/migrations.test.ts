import { nanoid } from "nanoid";
import { describe, expect, it } from "vitest";
import { readStoredBrushSize } from "@/core/brush/access";
import type { BlurFilter } from "../../renderer/filters";
import type {
	BrushPreset,
	BrushSettings,
	Document,
	FillAppearance,
	StrokeAppearance,
	Viewport,
} from "../../schema";
import { migAppearanceFilters } from "./20260221_mig_appearance_filters";
import { migBrushSettings } from "./20260224_mig_brush_settings";
import { migTiltPoolingDefaults } from "./20260228_mig_tilt_pooling_defaults";
import { migBrushUidRename } from "./20260304_mig_brush_uid_rename";
import { migHdrEnabled } from "./20260331_mig_hdr_enabled";
import { migColorProfile } from "./20260613_mig_color_profile";
import { migDefs } from "./20260617_mig_defs";
import { migRasterizationDpi } from "./20260705_mig_rasterization_dpi";
import { migGradientStopMidpoint } from "./20260722_mig_gradient_stop_midpoint";
import { migBrushV2 } from "./20260803_mig_brush_v2";
import { applyMigration, applyMigrations } from "./index";

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

function makeDoc(
	objects: Record<string, any>,
	schemaVersion?: number,
): Document {
	return {
		id: "test",
		objects,
		layers: [],
		viewport: defaultViewport,
		files: [],
		artboards: [],
		brushPresets: [],
		...(schemaVersion != null ? { schemaVersion } : {}),
	};
}

const IDENTITY_TRANSFORM = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function makeLegacyPath(overrides: Record<string, unknown> = {}) {
	return {
		id: "p1",
		type: "path" as const,
		opacity: 1,
		blendMode: "normal" as const,
		transform: IDENTITY_TRANSFORM,
		width: 3,
		segments: [],
		...overrides,
	};
}

describe("applyMigrations", () => {
	it("updates schemaVersion after migration", () => {
		const doc = makeDoc(
			{
				p1: makeLegacyPath({
					fill: {
						type: "solid" as const,
						color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
					},
				}),
			},
			0,
		);

		expect(doc.schemaVersion).toBe(0);
		applyMigrations(doc);
		expect(doc.schemaVersion).not.toBe(0);
	});

	it("skips migration when schemaVersion is already current", () => {
		const fill = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
		};
		const doc = makeDoc(
			{ p1: makeLegacyPath({ fill }) },
			20260228, // already migrated
		);

		applyMigrations(doc);

		// Legacy fill should still be there (migration was skipped)
		expect((doc.objects.p1 as any).fill).toEqual(fill);
	});

	it("skips migration when schemaVersion is newer", () => {
		const fill = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
		};
		const doc = makeDoc({ p1: makeLegacyPath({ fill }) }, 99999999);

		applyMigrations(doc);

		expect((doc.objects.p1 as any).fill).toEqual(fill);
		expect(doc.schemaVersion).toBe(99999999);
	});
});

describe("migAppearanceFilters (20260221)", () => {
	it("converts legacy fill into FillAppearance filter", () => {
		const fill = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
		};
		const doc = makeDoc({
			p1: makeLegacyPath({ fill }),
		});

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.p1 as any;
		expect(el.fill).toBeUndefined();
		expect(el.filters).toHaveLength(1);

		const f = el.filters[0] as FillAppearance;
		expect(f.processor).toBe("fill");
		expect(f.paramData.version).toBe("1");
		expect(f.paramData.params.fill).toEqual(fill);
	});

	it("converts legacy strokeColor into StrokeAppearance filter", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 },
		};
		const brushSettings = {
			textureFileUid: "tex-1",
			size: 10,
			opacity: 1,
			spacing: 0.2,
			randomSeed: 42,
			sizeByPressure: 0,
			opacityByPressure: 0,
			flow: 1,
			stampRotation: "none" as const,
			rotationByTilt: 0,
			aspectRatioByTilt: 0,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0,
		};
		const doc = makeDoc({
			p1: makeLegacyPath({ strokeColor, brushSettings, width: 5 }),
		});

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.p1 as any;
		expect(el.strokeColor).toBeUndefined();
		expect(el.brushSettings).toBeUndefined();
		expect(el.filters).toHaveLength(1);

		const f = el.filters[0] as StrokeAppearance;
		expect(f.processor).toBe("stroke");
		expect(f.paramData.version).toBe("1");
		expect(f.paramData.params.strokeColor).toEqual(strokeColor);
		expect(f.paramData.params.brushSettings).toEqual(brushSettings);
	});

	it("converts both fill and stroke, fill first in array", () => {
		const fill = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 1, b: 0, a: 1 },
		};
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		const doc = makeDoc({
			p1: makeLegacyPath({ fill, strokeColor, width: 2 }),
		});

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.p1 as any;
		expect(el.filters).toHaveLength(2);
		expect(el.filters[0].processor).toBe("fill");
		expect(el.filters[1].processor).toBe("stroke");
	});

	it("preserves existing non-appearance filters", () => {
		const fill = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
		};
		const blur: BlurFilter = {
			uid: nanoid(),
			processor: "blur",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: { version: "1", params: { radius: 5 } },
		};
		const doc = makeDoc({
			p1: makeLegacyPath({ fill, filters: [blur] }),
		});

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.p1 as any;
		expect(el.filters).toHaveLength(2);
		// Fill is unshifted (prepended), blur stays in place
		expect(el.filters[0].processor).toBe("fill");
		expect(el.filters[1].processor).toBe("blur");
	});

	it("skips element if FillAppearance already exists", () => {
		const fill = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
		};
		const existingFill: FillAppearance = {
			uid: nanoid(),
			processor: "fill",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb" as const, r: 0, g: 1, b: 0, a: 1 },
					},
				},
			},
		};
		const doc = makeDoc({
			p1: makeLegacyPath({ fill, filters: [existingFill] }),
		});

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.p1 as any;
		// Should keep the existing one, not add duplicate
		expect(el.filters).toHaveLength(1);
		expect(el.filters[0].paramData.params.fill.color.g).toBe(1);
	});

	it("skips elements without legacy properties", () => {
		const doc = makeDoc({
			p1: makeLegacyPath(),
		});

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.p1 as any;
		expect(el.filters).toBeUndefined();
	});

	it("defaults stroke width to 1 when element has no width", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		// Group element has no width property
		const group = {
			id: "g1",
			type: "group" as const,
			opacity: 1,
			blendMode: "normal" as const,
			transform: IDENTITY_TRANSFORM,
			childIds: [],
			strokeColor,
		};
		const doc = makeDoc({ g1: group });

		applyMigration(doc, migAppearanceFilters);

		const el = doc.objects.g1 as any;
		const f = el.filters[0] as StrokeAppearance;
		expect(readStoredBrushSize(f.paramData.params.brushSettings)).toBe(1);
	});

	it("migrates multiple elements in doc.objects", () => {
		const fill1 = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
		};
		const fill2 = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 1, b: 0, a: 1 },
		};
		const doc = makeDoc({
			p1: makeLegacyPath({ id: "p1", fill: fill1 }),
			p2: makeLegacyPath({ id: "p2", fill: fill2 }),
		});

		applyMigration(doc, migAppearanceFilters);

		expect(
			(doc.objects.p1 as any).filters[0].paramData.params.fill.color.r,
		).toBe(1);
		expect(
			(doc.objects.p2 as any).filters[0].paramData.params.fill.color.g,
		).toBe(1);
	});
});

describe("migBrushSettings (20260224)", () => {
	it("backfills missing brushSettings using element.width", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		const stroke: StrokeAppearance = {
			uid: nanoid(),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: { strokeColor },
			},
		};
		// makeLegacyPath has width:3 by default → should be used as size
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [stroke] } },
			20260221,
		);

		applyMigration(doc, migBrushSettings);

		const el = doc.objects.p1 as any;
		expect(el.width).toBeUndefined();
		const f = el.filters[0] as StrokeAppearance;
		expect(f.paramData.params.brushSettings).toBeDefined();
		expect(readStoredBrushSize(f.paramData.params.brushSettings)).toBe(3);
	});

	it("backfills missing brushSettings with 1px when no element.width", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		const stroke: StrokeAppearance = {
			uid: nanoid(),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: { strokeColor },
			},
		};
		// Element without width field
		const doc = makeDoc(
			{
				p1: {
					...makeLegacyPath(),
					filters: [stroke],
					width: undefined,
				},
			},
			20260221,
		);
		delete (doc.objects.p1 as any).width;

		applyMigration(doc, migBrushSettings);

		const f = (doc.objects.p1 as any).filters[0] as StrokeAppearance;
		expect(readStoredBrushSize(f.paramData.params.brushSettings)).toBe(1);
	});

	it("uses legacy element.width when backfilling missing brushSettings", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		const stroke: StrokeAppearance = {
			uid: nanoid(),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: { strokeColor },
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath({ width: 7 }), filters: [stroke] } },
			20260221,
		);

		applyMigration(doc, migBrushSettings);

		const el = doc.objects.p1 as any;
		expect(el.width).toBeUndefined();
		const f = el.filters[0] as StrokeAppearance;
		expect(readStoredBrushSize(f.paramData.params.brushSettings)).toBe(7);
	});

	it("does not overwrite existing brushSettings.size with element.width", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		const stroke: StrokeAppearance = {
			uid: nanoid(),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					strokeColor,
					brushSettings: {
						textureFileUid: "builtin-brush-solid",
						size: 3,
						sizeByPressure: 0,
						opacity: 1,
						opacityByPressure: 0,
						spacing: 0.15,
						flow: 1,
						stampRotation: "none" as const,
						randomSeed: 0,
						rotationByTilt: 0,
						aspectRatioByTilt: 0,
						sizeBySpeed: 0,
						pooling: 0,
						poolingSizeRatio: 0,
					} as unknown as BrushSettings,
				},
			},
		};
		// element.width=9 must NOT overwrite the already-correct brushSettings.size=3
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath({ width: 9 }), filters: [stroke] } },
			20260221,
		);

		applyMigration(doc, migBrushSettings);

		const el = doc.objects.p1 as any;
		expect(el.width).toBeUndefined();
		const f = el.filters[0] as StrokeAppearance;
		expect(readStoredBrushSize(f.paramData.params.brushSettings)).toBe(3);
		expect((f.paramData.params.brushSettings as any)?.textureFileUid).toBe(
			"builtin-brush-solid",
		);
	});

	it("keeps element.width when no StrokeAppearance exists to absorb it", () => {
		// fill-only element: has width but no stroke filter
		const fill: FillAppearance = {
			uid: nanoid(),
			processor: "fill",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath({ width: 5 }), filters: [fill] } },
			20260221,
		);

		applyMigration(doc, migBrushSettings);

		// width must be preserved — no StrokeAppearance could absorb it
		expect((doc.objects.p1 as any).width).toBe(5);
	});

	it("leaves existing brushSettings intact when no element.width", () => {
		const strokeColor = {
			type: "solid" as const,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
		};
		const stroke: StrokeAppearance = {
			uid: nanoid(),
			processor: "stroke",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					strokeColor,
					brushSettings: {
						textureFileUid: "builtin-brush-solid",
						size: 8,
						sizeByPressure: 0.5,
						opacity: 1,
						opacityByPressure: 0.2,
						spacing: 0.15,
						flow: 1,
						stampRotation: "none" as const,
						randomSeed: 0,
						rotationByTilt: 0,
						aspectRatioByTilt: 0,
						sizeBySpeed: 0,
						pooling: 0,
						poolingSizeRatio: 0,
					} as unknown as BrushSettings,
				},
			},
		};
		// No width field → brushSettings.size must not be overwritten
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [stroke] } },
			20260221,
		);
		delete (doc.objects.p1 as any).width;

		applyMigration(doc, migBrushSettings);

		const f = (doc.objects.p1 as any).filters[0] as StrokeAppearance;
		expect(readStoredBrushSize(f.paramData.params.brushSettings)).toBe(8);
		expect((f.paramData.params.brushSettings as any)?.textureFileUid).toBe(
			"builtin-brush-solid",
		);
	});

	it("skips filters that are not stroke", () => {
		const fill: FillAppearance = {
			uid: nanoid(),
			processor: "fill",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [fill] } },
			20260221,
		);

		applyMigration(doc, migBrushSettings);

		const f = (doc.objects.p1 as any).filters[0] as FillAppearance;
		expect(f.processor).toBe("fill");
		expect((f as any).paramData?.params?.brushSettings).toBeUndefined();
	});
});

describe("migTiltPoolingDefaults (20260228)", () => {
	it("backfills tilt/deltaTime defaults on segments", () => {
		const stroke: StrokeAppearance = {
			uid: "s1",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid",
						color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
					},
					brushSettings: {
						textureFileUid: "builtin-brush-solid",
						size: 5,
						sizeByPressure: 0,
						opacity: 1,
						opacityByPressure: 0,
						spacing: 0.15,
						flow: 1,
						stampRotation: "none" as const,
						randomSeed: 0,
						rotationByTilt: 0,
						aspectRatioByTilt: 0,
						sizeBySpeed: 0,
						pooling: 0,
						poolingSizeRatio: 0,
					} as unknown as BrushSettings,
				},
			},
		};
		const doc = makeDoc(
			{
				p1: {
					...makeLegacyPath(),
					filters: [stroke],
					segments: [
						{
							cp1: { x: 10, y: 0 },
							cp2: { x: -10, y: 0 },
							end: { x: 100, y: 0 },
							isMoved: true,
						},
					],
				},
			},
			20260224,
		);

		applyMigration(doc, migTiltPoolingDefaults);

		const seg = (doc.objects.p1 as any).segments[0];
		expect(seg.startTiltX).toBe(0);
		expect(seg.startTiltY).toBe(0);
		expect(seg.endTiltX).toBe(0);
		expect(seg.endTiltY).toBe(0);
		expect(seg.startDeltaTime).toBe(0);
		expect(seg.endDeltaTime).toBe(0);
	});

	it("backfills brush settings tilt/pooling/speed defaults", () => {
		const stroke: StrokeAppearance = {
			uid: "s1",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid",
						color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
					},
					brushSettings: {
						textureFileUid: "builtin-brush-solid",
						size: 5,
						sizeByPressure: 0.5,
						opacity: 1,
						opacityByPressure: 0,
						spacing: 0.15,
						flow: 1,
						stampRotation: "none" as const,
						randomSeed: 0,
						rotationByTilt: 0,
						aspectRatioByTilt: 0,
						sizeBySpeed: 0,
						pooling: 0,
						poolingSizeRatio: 0.5,
					} as unknown as BrushSettings,
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [stroke] } },
			20260224,
		);

		applyMigration(doc, migTiltPoolingDefaults);

		const bs = (doc.objects.p1 as any).filters[0].paramData.params
			.brushSettings;
		expect(bs.rotationByTilt).toBe(0);
		expect(bs.aspectRatioByTilt).toBe(0);
		expect(bs.sizeBySpeed).toBe(0);
		expect(bs.pooling).toBe(0);
		expect(bs.poolingSizeRatio).toBe(0.5);
	});

	it("does not overwrite existing tilt/pooling values", () => {
		const stroke: StrokeAppearance = {
			uid: "s1",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid",
						color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
					},
					brushSettings: {
						textureFileUid: "builtin-brush-solid",
						size: 5,
						sizeByPressure: 0,
						opacity: 1,
						opacityByPressure: 0,
						spacing: 0.15,
						flow: 1,
						stampRotation: "none" as const,
						randomSeed: 0,
						rotationByTilt: 0.8,
						aspectRatioByTilt: 0,
						sizeBySpeed: 0,
						pooling: 0.6,
						poolingSizeRatio: 0.5,
					} as unknown as BrushSettings,
				},
			},
		};
		const doc = makeDoc(
			{
				p1: {
					...makeLegacyPath(),
					filters: [stroke],
					segments: [
						{
							cp1: { x: 10, y: 0 },
							cp2: { x: -10, y: 0 },
							end: { x: 100, y: 0 },
							startTiltX: 45,
							isMoved: true,
						},
					],
				},
			},
			20260224,
		);

		applyMigration(doc, migTiltPoolingDefaults);

		const bs = (doc.objects.p1 as any).filters[0].paramData.params
			.brushSettings;
		expect(bs.rotationByTilt).toBe(0.8);
		expect(bs.pooling).toBe(0.6);
		// Backfilled fields
		expect(bs.aspectRatioByTilt).toBe(0);
		expect(bs.sizeBySpeed).toBe(0);
		expect(bs.poolingSizeRatio).toBe(0.5);

		const seg = (doc.objects.p1 as any).segments[0];
		expect(seg.startTiltX).toBe(45);
		// Backfilled fields
		expect(seg.startTiltY).toBe(0);
		expect(seg.endTiltX).toBe(0);
	});

	it("backfills brush preset defaults", () => {
		const doc = makeDoc({}, 20260224);
		doc.brushPresets = [
			{
				uid: "bp1",
				name: "Test",
				textureFileUid: "builtin-brush-solid",
				defaultSettings: {
					size: 10,
					sizeByPressure: 0.5,
					opacity: 1,
					opacityByPressure: 0,
					spacing: 0.15,
					flow: 1,
					stampRotation: "none",
				} as any,
			} as unknown as BrushPreset,
		];

		applyMigration(doc, migTiltPoolingDefaults);

		const ds = (doc.brushPresets[0] as any).defaultSettings as any;
		expect(ds.rotationByTilt).toBe(0);
		expect(ds.aspectRatioByTilt).toBe(0);
		expect(ds.sizeBySpeed).toBe(0);
		expect(ds.pooling).toBe(0);
		expect(ds.poolingSizeRatio).toBe(0.5);
	});
});

describe("migBrushUidRename (20260304)", () => {
	it("should rename builtin-brush-line to builtin-brush-hard-circle in brushSettings", () => {
		const doc = makeDoc(
			{
				p1: {
					id: "p1",
					type: "path",
					segments: [],
					filters: [
						{
							id: "s1",
							processor: "stroke",
							enabled: true,
							opacity: 1,
							blendMode: "normal",
							paramData: {
								version: 1,
								params: {
									strokeColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
									brushSettings: {
										textureFileUid: "builtin-brush-line",
										size: 5,
										sizeByPressure: 0,
										opacity: 1,
										opacityByPressure: 0,
										spacing: 0.02,
										flow: 1,
										stampRotation: "none",
										randomSeed: 0,
										rotationByTilt: 0,
										aspectRatioByTilt: 0,
										sizeBySpeed: 0,
										pooling: 0,
										poolingSizeRatio: 0.5,
									},
								},
							},
						},
					],
				},
			},
			20260301,
		);

		applyMigration(doc, migBrushUidRename);

		const bs = (doc.objects.p1 as any).filters[0].paramData.params
			.brushSettings;
		expect(bs.textureFileUid).toBe("builtin-brush-hard-circle");
	});

	it("should rename builtin-brush-solid to builtin-brush-soft-circle in brushSettings", () => {
		const doc = makeDoc(
			{
				p1: {
					id: "p1",
					type: "path",
					segments: [],
					filters: [
						{
							id: "s1",
							processor: "stroke",
							enabled: true,
							opacity: 1,
							blendMode: "normal",
							paramData: {
								version: 1,
								params: {
									strokeColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
									brushSettings: {
										textureFileUid: "builtin-brush-solid",
										size: 10,
										sizeByPressure: 0.5,
										opacity: 1,
										opacityByPressure: 0.3,
										spacing: 0.15,
										flow: 1,
										stampRotation: "none",
										randomSeed: 0,
										rotationByTilt: 0,
										aspectRatioByTilt: 0,
										sizeBySpeed: 0,
										pooling: 0,
										poolingSizeRatio: 0.5,
									},
								},
							},
						},
					],
				},
			},
			20260301,
		);

		applyMigration(doc, migBrushUidRename);

		const bs = (doc.objects.p1 as any).filters[0].paramData.params
			.brushSettings;
		expect(bs.textureFileUid).toBe("builtin-brush-soft-circle");
	});

	it("should rename embedded file UIDs", () => {
		const doc = makeDoc({}, 20260301);
		doc.files = [
			{
				uid: "builtin-brush-line",
				name: "Line",
				type: "image/png",
				hash: "abc",
				bin: new Uint8Array(),
			},
			{
				uid: "builtin-brush-solid",
				name: "Soft",
				type: "image/png",
				hash: "def",
				bin: new Uint8Array(),
			},
		];

		applyMigration(doc, migBrushUidRename);

		expect(doc.files[0].uid).toBe("builtin-brush-hard-circle");
		expect(doc.files[1].uid).toBe("builtin-brush-soft-circle");
	});

	it("should rename brush preset UIDs and textureFileUids", () => {
		const doc = makeDoc({}, 20260301);
		doc.brushPresets = [
			{
				uid: "builtin-brush-line",
				name: "Line",
				textureFileUid: "builtin-brush-line",
				defaultSettings: { size: 5 } as any,
			} as unknown as BrushPreset,
			{
				uid: "builtin-brush-solid",
				name: "Soft",
				textureFileUid: "builtin-brush-solid",
				defaultSettings: { size: 10 } as any,
			} as unknown as BrushPreset,
		];

		applyMigration(doc, migBrushUidRename);

		expect(doc.brushPresets[0].uid).toBe("builtin-brush-hard-circle");
		expect((doc.brushPresets[0] as any).textureFileUid).toBe(
			"builtin-brush-hard-circle",
		);
		expect(doc.brushPresets[1].uid).toBe("builtin-brush-soft-circle");
		expect((doc.brushPresets[1] as any).textureFileUid).toBe(
			"builtin-brush-soft-circle",
		);
	});

	it("should not modify non-builtin brush UIDs", () => {
		const doc = makeDoc(
			{
				p1: {
					id: "p1",
					type: "path",
					segments: [],
					filters: [
						{
							id: "s1",
							processor: "stroke",
							enabled: true,
							opacity: 1,
							blendMode: "normal",
							paramData: {
								version: 1,
								params: {
									strokeColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
									brushSettings: {
										textureFileUid: "custom-brush-123",
										size: 10,
									},
								},
							},
						},
					],
				},
			},
			20260301,
		);

		applyMigration(doc, migBrushUidRename);

		const bs = (doc.objects.p1 as any).filters[0].paramData.params
			.brushSettings;
		expect(bs.textureFileUid).toBe("custom-brush-123");
	});
});

describe("migHdrEnabled (20260331)", () => {
	it("should add default hdr settings to legacy document", () => {
		const doc = makeDoc({}, 20260304);

		expect(doc.hdr).toBeUndefined();

		applyMigration(doc, migHdrEnabled);

		expect(doc.hdr).toEqual({ enabled: false, exposure: 0 });
	});
});

describe("migColorProfile (20260613)", () => {
	it("should add default color profile settings to legacy document", () => {
		const doc = makeDoc({}, 20260407);

		expect(doc.colorProfile).toBeUndefined();

		applyMigration(doc, migColorProfile);

		expect(doc.colorProfile).toEqual({ workingSpace: "display-p3" });
	});

	it("should keep existing color profile settings", () => {
		const doc = makeDoc({}, 20260407);
		doc.colorProfile = { workingSpace: "srgb", proofIntent: "perceptual" };

		applyMigration(doc, migColorProfile);

		expect(doc.colorProfile).toEqual({
			workingSpace: "srgb",
			proofIntent: "perceptual",
		});
	});
});

describe("migDefs (20260617)", () => {
	it("should add empty defs map to legacy document", () => {
		const doc = makeDoc({}, 20260613);

		expect(doc.defs).toBeUndefined();

		applyMigration(doc, migDefs);

		expect(doc.defs).toEqual({});
	});

	it("should keep existing defs map", () => {
		const doc = makeDoc({}, 20260613);
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["p1"],
				tile: { width: 100, height: 100 },
			},
		};

		applyMigration(doc, migDefs);

		expect(doc.defs).toEqual({
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["p1"],
				tile: { width: 100, height: 100 },
			},
		});
	});
});

describe("migRasterizationDpi (20260705)", () => {
	it("should add default rasterization dpi to legacy document", () => {
		const doc = makeDoc({}, 20260617);

		expect(doc.rasterizationDpi).toBeUndefined();

		applyMigration(doc, migRasterizationDpi);

		expect(doc.rasterizationDpi).toBe(72);
	});

	it("should keep existing rasterization dpi", () => {
		const doc = makeDoc({}, 20260617);
		doc.rasterizationDpi = 144;

		applyMigration(doc, migRasterizationDpi);

		expect(doc.rasterizationDpi).toBe(144);
	});
});

describe("migGradientStopMidpoint (20260722)", () => {
	function makeLegacyStops() {
		return [
			{ offset: 0, color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 } },
			{ offset: 1, color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 } },
		];
	}

	it("sets midpoint on linear gradient fill stops", () => {
		const fill: FillAppearance = {
			uid: "f1",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "linear",
						x1: 0,
						y1: 0,
						x2: 1,
						y2: 0,
						stops: makeLegacyStops(),
					} as any,
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [fill] } },
			20260705,
		);

		applyMigration(doc, migGradientStopMidpoint);

		const stops = (doc.objects.p1 as any).filters[0].paramData.params.fill
			.stops;
		expect(stops[0].midpoint).toBe(0.5);
		expect(stops[1].midpoint).toBe(0.5);
	});

	it("sets midpoint on radial gradient fill stops", () => {
		const fill: FillAppearance = {
			uid: "f1",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "radial",
						cx: 0.5,
						cy: 0.5,
						radiusX: 0.5,
						radiusY: 0.5,
						rotation: 0,
						stops: makeLegacyStops(),
					} as any,
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [fill] } },
			20260705,
		);

		applyMigration(doc, migGradientStopMidpoint);

		const stops = (doc.objects.p1 as any).filters[0].paramData.params.fill
			.stops;
		expect(stops[0].midpoint).toBe(0.5);
		expect(stops[1].midpoint).toBe(0.5);
	});

	it("sets midpoint on stroke-gradient stops", () => {
		const stroke: StrokeAppearance = {
			uid: "s1",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "stroke-gradient",
						mode: "within",
						gradient: {
							type: "linear",
							x1: 0,
							y1: 0,
							x2: 1,
							y2: 0,
							stops: makeLegacyStops(),
						},
					} as any,
					brushSettings: {
						textureFileUid: "builtin-brush-solid",
						size: 5,
					} as any,
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [stroke] } },
			20260705,
		);

		applyMigration(doc, migGradientStopMidpoint);

		const stops = (doc.objects.p1 as any).filters[0].paramData.params
			.strokeColor.gradient.stops;
		expect(stops[0].midpoint).toBe(0.5);
		expect(stops[1].midpoint).toBe(0.5);
	});

	it("does not overwrite existing midpoint values", () => {
		const fill: FillAppearance = {
			uid: "f1",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "linear",
						x1: 0,
						y1: 0,
						x2: 1,
						y2: 0,
						stops: [
							{
								offset: 0,
								color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
								midpoint: 0.3,
							},
							{
								offset: 1,
								color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
							},
						] as any,
					},
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [fill] } },
			20260705,
		);

		applyMigration(doc, migGradientStopMidpoint);

		const stops = (doc.objects.p1 as any).filters[0].paramData.params.fill
			.stops;
		expect(stops[0].midpoint).toBe(0.3);
		expect(stops[1].midpoint).toBe(0.5);
	});

	it("leaves non-gradient fills untouched", () => {
		const fill: FillAppearance = {
			uid: "f1",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		};
		const doc = makeDoc(
			{ p1: { ...makeLegacyPath(), filters: [fill] } },
			20260705,
		);

		applyMigration(doc, migGradientStopMidpoint);

		expect((doc.objects.p1 as any).filters[0].paramData.params.fill).toEqual({
			type: "solid",
			color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
		});
	});

	it("updates schemaVersion to 20260803 via applyMigrations", () => {
		const doc = makeDoc({}, 20260705);

		applyMigrations(doc);

		expect(doc.schemaVersion).toBe(20260803);
	});
});

describe("migBrushV2 (20260803)", () => {
	function makeV1ScatterSettings(): Record<string, unknown> {
		return {
			type: "scatter",
			size: 20,
			sizeByPressure: 0.5,
			opacity: 0.8,
			opacityByPressure: 0.3,
			randomSeed: 7,
			source: { kind: "file", fileUid: "tex-1" },
			spacing: 0.12,
			flow: 0.6,
			stampRotation: "none",
			rotationByTilt: 0,
			aspectRatioByTilt: 0,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
			wetInk: {
				enabled: true,
				bleedWidth: 0.5,
				edgeDarkening: 0.4,
				edgeRoughness: 0.3,
				paperGrain: 0.2,
				paperScale: 1,
				directionality: 0.4,
				speedInfluence: 0.5,
				accelInfluence: 0.3,
				wetness: 0.7,
				pigmentLoad: 0.85,
				absorption: 0.35,
				granulation: 0.25,
				pickupUnderlyingColor: true,
				pickupStrength: 0.35,
			},
		};
	}

	function makeBrushDoc(): Document {
		const doc = makeDoc({
			p1: makeLegacyPath({
				filters: [
					{
						enabled: true,
						processor: "stroke",
						opacity: 1,
						blendMode: "normal",
						paramData: {
							params: {
								strokeColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
								brushSettings: makeV1ScatterSettings(),
							},
						},
					},
				],
			}),
		});
		doc.brushPresets = [
			{
				uid: "preset-1",
				name: "Preset 1",
				settings: {
					type: "stroke",
					size: 4,
					sizeByPressure: 0,
					opacity: 1,
					opacityByPressure: 0,
					randomSeed: 0,
				} as BrushSettings,
			},
		];
		return doc;
	}

	it("migrates element filters and document presets to v2 simultaneously", () => {
		const doc = makeBrushDoc();

		applyMigration(doc, migBrushV2);

		const filterParams = (doc.objects.p1 as any).filters[0].paramData
			.params as Record<string, any>;
		expect(filterParams.brushSettings.version).toBe(2);
		expect(filterParams.brushSettings.engine).toBe("dab");
		expect((doc.brushPresets?.[0]?.settings as any).version).toBe(2);
		expect((doc.brushPresets?.[0]?.settings as any).engine).toBe("geometric");
	});

	it("preserves wet ink settings as wetV1 without synthesizing v2 wet", () => {
		const doc = makeBrushDoc();

		applyMigration(doc, migBrushV2);

		const bs = (doc.objects.p1 as any).filters[0].paramData.params
			.brushSettings as Record<string, any>;
		expect(bs.wetV1?.enabled).toBe(true);
		expect(bs.wetV1?.bleedWidth).toBeCloseTo(0.5, 10);
		expect(bs.wet).toBeUndefined();
	});

	it("converts a legacy flat preset shape (defaultSettings + textureFileUid)", () => {
		const doc = makeDoc({});
		doc.brushPresets = [
			{
				uid: "legacy-1",
				name: "Legacy",
				defaultSettings: { size: 9 },
				textureFileUid: "builtin-brush-soft-circle",
			} as unknown as BrushPreset,
		];

		applyMigration(doc, migBrushV2);

		const settings = (doc.brushPresets?.[0] as any).settings;
		expect(settings.version).toBe(2);
		expect(settings.engine).toBe("dab");
		expect(settings.properties.size.base).toBe(9);
	});

	it("is idempotent when applied twice", () => {
		const doc = makeBrushDoc();

		applyMigration(doc, migBrushV2);
		const once = structuredClone(doc);
		doc.schemaVersion = undefined;
		applyMigration(doc, migBrushV2);
		doc.schemaVersion = once.schemaVersion;

		expect(doc).toEqual(once);
	});
});
