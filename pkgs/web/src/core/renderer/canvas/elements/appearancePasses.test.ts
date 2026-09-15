import { describe, expect, it } from "vitest";
import { createDefaultTransform } from "../../../document/factory";
import type {
	Filter,
	Path,
	PathSegment,
	StrokeAppearance,
} from "../../../schema";
import {
	type AppearanceGeometry,
	appearancePaintsPattern,
} from "../pipeline/FilterRenderer";
import {
	collectDrawableAppearances,
	resolveAppearancePasses,
} from "./appearancePasses";

// "zigzag" stands in for a geometry-deforming (preProcess) handler; "blur" for
// a post-process-only one, which leaves the appearance's coverage intact.
// "copier" stands in for a copy-placing handler (transform) whose pattern
// paints follow the copy; "shrinker" for one that scales stroke widths
// instead. Both emit the input plus one copy moved by +20 in x.
const filterRenderer = {
	getHandler: (processor: string) =>
		processor === "zigzag"
			? {
					preProcess: (segments: PathSegment[]) =>
						segments.map((s) => ({ ...s, end: { ...s.end, y: s.end.y + 5 } })),
				}
			: processor === "copier"
				? {
						preProcess: (segments: PathSegment[]) => [
							...segments,
							...moveSegments(segments, 20),
						],
						preProcessAppearance: (g: AppearanceGeometry) =>
							appearancePaintsPattern(g.appearance)
								? [
										{
											...g,
											patternTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
										},
										{
											...g,
											segments: moveSegments(g.segments as PathSegment[], 20),
											patternTransform: {
												a: 1,
												b: 0,
												c: 0,
												d: 1,
												e: -20,
												f: 0,
											},
										},
									]
								: [
										{
											...g,
											segments: [
												...g.segments,
												...moveSegments(g.segments as PathSegment[], 20),
											],
										},
									],
					}
				: processor === "shrinker"
					? {
							preProcess: (segments: PathSegment[]) => [
								...segments,
								...moveSegments(segments, 20),
							],
							preProcessAppearance: (g: AppearanceGeometry) =>
								g.appearance?.processor === "stroke"
									? [
											g,
											{
												appearance: withStrokeWidth(g.appearance, 1.5),
												segments: moveSegments(g.segments as PathSegment[], 20),
											},
										]
									: [
											{
												...g,
												segments: [
													...g.segments,
													...moveSegments(g.segments as PathSegment[], 20),
												],
											},
										],
						}
					: undefined,
} as never;

describe("collectDrawableAppearances", () => {
	it("should drop fills hidden by a later fully-opaque solid fill", () => {
		const path = pathWith([solidFill("under"), solidFill("top")]);

		expect(uids(collectDrawableAppearances(path, filterRenderer))).toEqual([
			"top",
		]);
	});

	it("should keep earlier fills when the later fill is not fully opaque", () => {
		const semi = pathWith([
			solidFill("under"),
			solidFill("semi", { colorAlpha: 0.5 }),
		]);
		const faded = pathWith([
			solidFill("under"),
			solidFill("faded", { opacity: 0.5 }),
		]);
		const blended = pathWith([
			solidFill("under"),
			solidFill("blended", { blendMode: "multiply" }),
		]);

		expect(uids(collectDrawableAppearances(semi, filterRenderer))).toEqual([
			"under",
			"semi",
		]);
		expect(uids(collectDrawableAppearances(faded, filterRenderer))).toEqual([
			"under",
			"faded",
		]);
		expect(uids(collectDrawableAppearances(blended, filterRenderer))).toEqual([
			"under",
			"blended",
		]);
	});

	it("should keep strokes and their paint order", () => {
		const path = pathWith([
			stroke("outline"),
			solidFill("under"),
			solidFill("top"),
			stroke("over"),
		]);

		expect(uids(collectDrawableAppearances(path, filterRenderer))).toEqual([
			"outline",
			"top",
			"over",
		]);
	});

	it("should exempt a fill deformed by a sub-filter from occlusion on both sides", () => {
		// The deformed fill is opaque/solid/normal — it would normally occlude
		// "under" — but its geometry no longer covers the flat shape, so both
		// must survive.
		const path = pathWith([
			solidFill("under"),
			solidFill("zigzagged", { subFilters: [subFilter("zz", "zigzag")] }),
		]);

		expect(uids(collectDrawableAppearances(path, filterRenderer))).toEqual([
			"under",
			"zigzagged",
		]);
	});

	it("should still occlude through a post-process-only sub-filter", () => {
		// blur doesn't deform geometry, so the blurred fill still covers "under".
		const path = pathWith([
			solidFill("under"),
			solidFill("blurred", { subFilters: [subFilter("b", "blur")] }),
		]);

		expect(uids(collectDrawableAppearances(path, filterRenderer))).toEqual([
			"blurred",
		]);
	});
});

describe("resolveAppearancePasses", () => {
	it("should deform only the appearance carrying the sub-filter", () => {
		const path = pathWith([
			stroke("plain-stroke"),
			solidFill("plain-fill", { colorAlpha: 0.5 }),
			solidFill("zigzagged", {
				colorAlpha: 0.5,
				subFilters: [subFilter("zz", "zigzag")],
			}),
		]);

		const passes = resolveAppearancePasses(path, filterRenderer);

		expect(passes.map((p) => p.appearance.uid)).toEqual([
			"plain-stroke",
			"plain-fill",
			"zigzagged",
		]);
		expect(passes[0].segments[0].end.y).toBe(0);
		expect(passes[1].segments[0].end.y).toBe(0);
		expect(passes[2].segments[0].end.y).toBe(5);
	});

	it("should give a deformed appearance its own geometry cache key", () => {
		const path = pathWith([
			solidFill("plain", { colorAlpha: 0.5 }),
			solidFill("zigzagged", {
				colorAlpha: 0.5,
				subFilters: [subFilter("zz", "zigzag")],
			}),
		]);

		const [plain, deformed] = resolveAppearancePasses(path, filterRenderer);

		expect(plain.cacheKey).toBe("path-1");
		expect(deformed.cacheKey).not.toBe(plain.cacheKey);
	});

	it("should return no passes for a path without drawable appearances", () => {
		expect(resolveAppearancePasses(pathWith([]), filterRenderer)).toEqual([]);
	});

	it("should anchor a pattern fill to the flat outline top-left", () => {
		const path = pathWith([patternFill("pat"), subFilter("zz", "zigzag")]);

		const [pass] = resolveAppearancePasses(path, filterRenderer);

		expect(pass.segments[0].end.y).toBe(5);
		expect(pass.pattern).toEqual({ anchor: [0, 0] });
	});

	it("should draw a pattern fill once per copy with the filter's pattern transform", () => {
		const path = pathWith([
			solidFill("solid", { colorAlpha: 0.5 }),
			patternFill("pat"),
			subFilter("cp", "copier"),
		]);

		const passes = resolveAppearancePasses(path, filterRenderer);

		expect(passes.map((p) => p.appearance.uid)).toEqual([
			"solid",
			"pat",
			"pat",
		]);
		expect(passes[0].segments).toHaveLength(2);
		expect(passes[0].pattern).toBeUndefined();
		expect(passes[1].segments[0].end.x).toBe(10);
		expect(passes[1].pattern?.transform).toMatchObject({ e: 0 });
		expect(passes[2].segments[0].end.x).toBe(30);
		expect(passes[2].pattern?.transform).toMatchObject({ e: -20 });
		expect(passes[1].cacheKey).not.toBe(passes[2].cacheKey);
	});

	it("should let a sub-filter below a pattern fill split it per copy too", () => {
		const path = pathWith([
			patternFill("pat", { subFilters: [subFilter("cp", "copier")] }),
		]);

		const passes = resolveAppearancePasses(path, filterRenderer);

		expect(passes.map((p) => p.appearance.uid)).toEqual(["pat", "pat"]);
		expect(passes[1].segments[0].end.x).toBe(30);
		expect(passes[1].pattern?.transform).toMatchObject({ e: -20 });
	});

	it("should draw a stroke once per copy with the filter's rewritten width", () => {
		const path = pathWith([
			patternFill("pat"),
			stroke("line"),
			subFilter("sh", "shrinker"),
		]);

		const passes = resolveAppearancePasses(path, filterRenderer);

		expect(passes.map((p) => p.appearance.uid)).toEqual([
			"pat",
			"line",
			"line",
		]);
		expect(passes[0].pattern).toEqual({ anchor: [0, 0] });
		expect(strokeWidthOf(passes[1])).toBe(3);
		expect(strokeWidthOf(passes[2])).toBe(1.5);
	});
});

// ===== Test helpers =====

function uids(filters: readonly Filter[]): string[] {
	return filters.map((f) => f.uid);
}

function pathWith(filters: Filter[]): Path {
	return {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [lineSegment()],
		filters,
	};
}

function solidFill(
	uid: string,
	{
		colorAlpha = 1,
		opacity = 1,
		blendMode = "normal",
		subFilters,
	}: {
		colorAlpha?: number;
		opacity?: number;
		blendMode?: string;
		subFilters?: Filter[];
	} = {},
): Filter {
	return {
		uid,
		processor: "fill",
		opacity,
		blendMode,
		subFilters,
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: 1, g: 0, b: 0, a: colorAlpha },
				},
			},
		},
	} as Filter;
}

function patternFill(
	uid: string,
	{ subFilters }: { subFilters?: Filter[] } = {},
): Filter {
	return {
		uid,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		subFilters,
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "pattern",
					defId: "def-1",
					scaleX: 1,
					scaleY: 1,
					rotation: 0,
					offsetX: 0,
					offsetY: 0,
				},
			},
		},
	} as Filter;
}

function moveSegments(segments: PathSegment[], dx: number): PathSegment[] {
	return segments.map((s) => ({
		...s,
		...(s.start ? { start: { ...s.start, x: s.start.x + dx } } : {}),
		end: { ...s.end, x: s.end.x + dx },
	}));
}

function withStrokeWidth(stroke: Filter, width: number): StrokeAppearance {
	const app = stroke as StrokeAppearance;
	const settings = app.paramData.params.brushSettings!;
	return {
		...app,
		paramData: {
			...app.paramData,
			params: {
				...app.paramData.params,
				brushSettings: {
					...settings,
					properties: { ...settings.properties, size: { base: width } },
				},
			},
		},
	};
}

function strokeWidthOf(pass: { appearance: Filter }): number | undefined {
	return (pass.appearance as StrokeAppearance).paramData.params.brushSettings
		?.properties.size?.base;
}

function stroke(uid: string): Filter {
	return {
		uid,
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				brushSettings: {
					version: 2,
					engine: "geometric",
					strokeOpacity: 1,
					paintMode: "buildup",
					properties: { size: { base: 3 }, flow: { base: 1 } },
					randomSeed: 0,
				},
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				},
			},
		},
	} as Filter;
}

function subFilter(uid: string, processor: string): Filter {
	return {
		uid,
		processor,
		enabled: true,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	} as Filter;
}

function lineSegment(): PathSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 10, y: 0 },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: true,
	};
}
