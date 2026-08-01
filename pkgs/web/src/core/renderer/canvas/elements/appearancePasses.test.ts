import { describe, expect, it } from "vitest";
import { createDefaultTransform } from "../../../document/factory";
import type { Filter, Path, PathSegment } from "../../../schema";
import {
	collectDrawableAppearances,
	resolveAppearancePasses,
} from "./appearancePasses";

// "zigzag" stands in for a geometry-deforming (preProcess) handler; "blur" for
// a post-process-only one, which leaves the appearance's coverage intact.
const filterRenderer = {
	getHandler: (processor: string) =>
		processor === "zigzag"
			? {
					preProcess: (segments: PathSegment[]) =>
						segments.map((s) => ({ ...s, end: { ...s.end, y: s.end.y + 5 } })),
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

function stroke(uid: string): Filter {
	return {
		uid,
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
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
