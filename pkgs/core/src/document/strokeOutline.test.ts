import { describe, expect, it } from "vitest";
import type { FilterHandler } from "../renderer/canvas/pipeline/FilterRenderer";
import {
	type AnyArtObject,
	type BrushSettings,
	type CubicBezierSegment,
	type ElementTransform,
	type FillAppearance,
	type Filter,
	type Group,
	isIdentityTransform,
	type Path,
	type StrokeAppearance,
} from "../schema";
import { calculateSegmentListBounds } from "../utils/geometry/bounds";
import { createStrokeBrushSettings } from "./factory";
import { buildStrokeOutline, canOutlineStrokes } from "./strokeOutline";

describe("canOutlineStrokes", () => {
	it("should accept a path or compound path with a solid geometric stroke", () => {
		expect(canOutlineStrokes(squarePath([stroke()]))).toBe(true);
		expect(
			canOutlineStrokes({
				type: "compound-path",
				id: "compound",
				opacity: 1,
				blendMode: "normal",
				transform: identity(),
				sources: [],
				filters: [stroke()],
			}),
		).toBe(true);
	});

	it("should accept a stroke outlining leaves as a stroke", () => {
		expect(
			canOutlineStrokes(
				squarePath([stroke({ brushSettings: { engine: "dab" } })]),
			),
		).toBe(true);
	});

	it("should reject paths without an enabled stroke and guides", () => {
		expect(canOutlineStrokes(squarePath([fill()]))).toBe(false);
		expect(
			canOutlineStrokes(squarePath([{ ...stroke(), enabled: false }])),
		).toBe(false);
		expect(
			canOutlineStrokes({ ...squarePath([stroke()]), isGuide: true }),
		).toBe(false);
	});
});

describe("buildStrokeOutline", () => {
	it("should turn a stroke-only path into one path filled with the stroke color", () => {
		const path = squarePath([stroke()]);

		const result = buildStrokeOutline(path, deps([path]));

		const root = result?.root as Path;
		expect(root.type).toBe("path");
		expect(root.id).toBe(path.id);
		expect(result?.children).toEqual([]);
		expect(root.filters).toHaveLength(1);
		expect((root.filters?.[0] as FillAppearance).processor).toBe("fill");
		expect((root.filters?.[0] as FillAppearance).paramData.params.fill).toEqual(
			RED,
		);
		// A 100×100 square stroked 10 wide: an outer ring and a hole.
		expect(root.segments.filter((seg) => seg.isMoved)).toHaveLength(2);
		const bounds = calculateSegmentListBounds(root.segments);
		expect(bounds?.width).toBeCloseTo(110, 0);
		expect(bounds?.height).toBeCloseTo(110, 0);
	});

	it("should group a filled and stroked path into its fill and its outline in stack order", () => {
		const underFill = squarePath([stroke(), fill()]);
		const overFill = squarePath([fill(), stroke()]);

		const under = buildStrokeOutline(underFill, deps([underFill]));
		const over = buildStrokeOutline(overFill, deps([overFill]));

		const underRoot = under?.root as Group;
		expect(underRoot.type).toBe("group");
		expect(underRoot.id).toBe(underFill.id);
		expect(underRoot.childIds).toEqual(under?.children.map((c) => c.id));
		expect(underRoot.filters?.[0]).toMatchObject({ processor: "content" });
		expect(paintOf(under?.children[0])).toEqual(RED);
		expect(paintOf(under?.children[1])).toEqual(BLUE);
		expect(paintOf(over?.children[0])).toEqual(BLUE);
		expect(paintOf(over?.children[1])).toEqual(RED);
	});

	it("should keep appearances that apply to the whole element on the group", () => {
		const blur = appearance("blur");
		const path = squarePath([fill(), stroke(), blur]);

		const result = buildStrokeOutline(path, deps([path]));

		expect((result?.root as Group).filters?.slice(1)).toEqual([blur]);
	});

	it("should bake geometry filters into the outline and drop them from the stack", () => {
		const shift = appearance("shift");
		const path = squarePath([shift, stroke()]);

		const result = buildStrokeOutline(path, deps([path]));

		const root = result?.root as Path;
		expect(root.filters?.map((f) => (f as Filter).processor)).toEqual(["fill"]);
		expect(calculateSegmentListBounds(root.segments)?.minX).toBeCloseTo(95, 0);
	});

	it("should bake the element transform and keep its mask content in place", () => {
		const mask = { ...squarePath([fill()]), id: "mask" };
		const path: Path = {
			...squarePath([stroke()]),
			transform: { ...identity(), x: 200 },
			mask: { elementIds: [mask.id] },
		};

		const result = buildStrokeOutline(path, deps([path, mask]));

		const root = result?.root as Path;
		expect(isIdentityTransform(root.transform)).toBe(true);
		expect(calculateSegmentListBounds(root.segments)?.minX).toBeCloseTo(195, 0);
		expect(result?.maskTransforms.get(mask.id)?.x).toBeCloseTo(200);
	});

	it("should return null when no stroke outlines", () => {
		const path = squarePath([
			fill(),
			stroke({ brushSettings: { engine: "dab" } }),
		]);

		expect(buildStrokeOutline(path, deps([path]))).toBeNull();
	});
});

// --- Helpers ---

const RED = {
	type: "solid" as const,
	color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
};
const BLUE = {
	type: "solid" as const,
	color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 },
};

/** Handlers the tests resolve: `shift` moves geometry 100 to the right; `blur` post-processes. */
const HANDLERS: Record<string, FilterHandler> = {
	shift: {
		preProcess: (segments: CubicBezierSegment[]) =>
			segments.map((seg) => ({
				...seg,
				...(seg.start
					? { start: { x: seg.start.x + 100, y: seg.start.y } }
					: {}),
				end: { x: seg.end.x + 100, y: seg.end.y },
			})),
	} as unknown as FilterHandler,
	blur: { postProcess: () => undefined } as unknown as FilterHandler,
};

function deps(elements: AnyArtObject[]) {
	return {
		objects: Object.fromEntries(elements.map((el) => [el.id, el])),
		elementsMap: new Map(elements.map((el) => [el.id, el])),
		filterRenderer: { getHandler: (processor: string) => HANDLERS[processor] },
	};
}

function identity(): ElementTransform {
	return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
}

function appearance(processor: string, params: object = {}): Filter {
	return {
		uid: `app-${processor}-${Math.random()}`,
		processor,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params },
	};
}

function fill(): FillAppearance {
	return appearance("fill", { fill: BLUE }) as FillAppearance;
}

function stroke(
	overrides: { brushSettings?: Partial<BrushSettings> } = {},
): StrokeAppearance {
	return appearance("stroke", {
		strokeColor: RED,
		brushSettings: {
			...createStrokeBrushSettings(10, {
				lineJoin: "miter",
				lineCap: "butt",
				miterLimit: 4,
			}),
			...overrides.brushSettings,
		},
	}) as StrokeAppearance;
}

function paintOf(path: Path | undefined) {
	return (path?.filters?.[0] as FillAppearance | undefined)?.paramData.params
		.fill;
}

/** A closed 100×100 square from (0, 0) to (100, 100). */
function squarePath(filters: Filter[]): Path {
	const corner = (x: number, y: number, first = false): CubicBezierSegment => ({
		...(first ? { start: { x: 0, y: 0 } } : {}),
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x, y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: first,
	});
	return {
		type: "path",
		id: `path-${Math.random()}`,
		opacity: 1,
		blendMode: "normal",
		transform: identity(),
		filters,
		segments: [
			corner(100, 0, true),
			corner(100, 100),
			corner(0, 100),
			{ ...corner(0, 0), isClosed: true },
		],
	};
}
