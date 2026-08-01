import { describe, expect, it } from "vitest";
import type {
	FillAppearance,
	Group,
	Path,
	StrokeAppearance,
	TextElement,
} from "../schema";
import {
	type ParseCtx,
	parseSvgColor,
	parseSvgPathD,
	parseSvgToArtObjects,
} from "./svgImport";

// --- Helpers ---

const defaultCtx = (): ParseCtx => ({
	viewBox: { x: 0, y: 0, width: 100, height: 100 },
	pasteWorldX: 0,
	pasteWorldY: 0,
	gradients: new Map(),
	cssClasses: new Map(),
	clipPaths: new Map(),
	patternFills: new Map(),
	filters: new Map(),
});

// --- parseSvgColor ---

describe("parseSvgColor", () => {
	it("#ff0000 → {type:rgb, r:1, g:0, b:0, a:1}", () => {
		const c = parseSvgColor("#ff0000");
		expect(c).toEqual({ type: "rgb", r: 1, g: 0, b: 0, a: 1 });
	});

	it("#f00 → {r:1, g:0, b:0}", () => {
		const c = parseSvgColor("#f00");
		expect(c).toEqual({ type: "rgb", r: 1, g: 0, b: 0, a: 1 });
	});

	it("rgb(255,0,0)", () => {
		const c = parseSvgColor("rgb(255,0,0)");
		expect(c).toEqual({ type: "rgb", r: 1, g: 0, b: 0, a: 1 });
	});

	it("rgba(255,0,0,0.5) → a=0.5", () => {
		const c = parseSvgColor("rgba(255,0,0,0.5)");
		expect(c?.a).toBeCloseTo(0.5);
		expect(c?.r).toBe(1);
	});

	it("none → null", () => {
		expect(parseSvgColor("none")).toBeNull();
	});

	it("transparent → null", () => {
		expect(parseSvgColor("transparent")).toBeNull();
	});

	it("red (CSS name) → {r:1, g:0, b:0, a:1}", () => {
		const c = parseSvgColor("red");
		expect(c).toEqual({ type: "rgb", r: 1, g: 0, b: 0, a: 1 });
	});

	it("unknown name → null", () => {
		expect(parseSvgColor("notacolor")).toBeNull();
	});
});

// --- parseSvgPathD ---

describe("parseSvgPathD", () => {
	it("M 10 20 L 30 40 → isMoved=true, cp1/cp2={0,0}", () => {
		const ctx = defaultCtx();
		const segs = parseSvgPathD("M 10 20 L 30 40", new DOMMatrix(), ctx);
		expect(segs).toHaveLength(1);
		expect(segs[0].isMoved).toBe(true);
		expect(segs[0].start).toBeDefined();
		expect(segs[0].cp1).toEqual({ x: 0, y: 0 });
		expect(segs[0].cp2).toEqual({ x: 0, y: 0 });
	});

	it("M 0 0 C 10 20 30 40 50 60 → cubic bezier, cp1/cp2 are relative offsets", () => {
		const ctx = defaultCtx();
		// viewBox 0 0 100 100 → center=(50,50)
		// world(0,0) in SVG = (-50, 50) in world
		// world(10,20) in SVG = (-40, 30) in world
		// world(30,40) in SVG = (-20, 10) in world
		// world(50,60) in SVG = (0, -10) in world
		const segs = parseSvgPathD(
			"M 0 0 C 10 20 30 40 50 60",
			new DOMMatrix(),
			ctx,
		);
		expect(segs).toHaveLength(1);
		expect(segs[0].isMoved).toBe(true);

		// cp1 should be relative to start anchor: world(10,20) - world(0,0) = (-40-(-50), 30-50) = (10,-20)
		expect(segs[0].cp1.x).toBeCloseTo(10);
		expect(segs[0].cp1.y).toBeCloseTo(-20);

		// cp2 should be relative to end anchor: world(30,40) - world(50,60) = (-20-0, 10-(-10)) = (-20,20)
		expect(segs[0].cp2.x).toBeCloseTo(-20);
		expect(segs[0].cp2.y).toBeCloseTo(20);
	});

	it("M 0 0 Z → isClosed=true", () => {
		const ctx = defaultCtx();
		const segs = parseSvgPathD("M 0 0 Z", new DOMMatrix(), ctx);
		expect(segs.length).toBeGreaterThan(0);
		expect(segs[segs.length - 1].isClosed).toBe(true);
	});

	it("M 10 20 L 30 40 Z → explicit closing segment back to the start, isClosed", () => {
		const ctx = defaultCtx();
		const segs = parseSvgPathD("M 10 20 L 30 40 Z", new DOMMatrix(), ctx);
		// Z adds an explicit closing segment (30,40)->(10,20) so the ring returns
		// to its start, matching native closed shapes.
		expect(segs).toHaveLength(2);
		expect(segs[1].isClosed).toBe(true);
		const start = segs[0].start!;
		expect(segs[1].end.x).toBeCloseTo(start.x);
		expect(segs[1].end.y).toBeCloseTo(start.y);
	});

	it("relative m/l matches absolute M/L", () => {
		const ctx = defaultCtx();
		// Absolute: M 10 20 L 30 40 (start from origin (0,0))
		const absSegs = parseSvgPathD("M 10 20 L 30 40", new DOMMatrix(), ctx);
		// Relative: m 10 20 l 20 20 (same path, starting from (0,0))
		const relSegs = parseSvgPathD("m 10 20 l 20 20", new DOMMatrix(), ctx);

		expect(relSegs).toHaveLength(1);
		expect(relSegs[0].start?.x).toBeCloseTo(absSegs[0].start!.x);
		expect(relSegs[0].start?.y).toBeCloseTo(absSegs[0].start!.y);
		expect(relSegs[0].end.x).toBeCloseTo(absSegs[0].end.x);
		expect(relSegs[0].end.y).toBeCloseTo(absSegs[0].end.y);
	});

	it("relative c matches absolute C", () => {
		const ctx = defaultCtx();
		const absSegs = parseSvgPathD(
			"M 0 0 C 10 20 30 40 50 60",
			new DOMMatrix(),
			ctx,
		);
		// m 0 0 c 10 20 30 40 50 60 — all relative to (0,0)
		const relSegs = parseSvgPathD(
			"m 0 0 c 10 20 30 40 50 60",
			new DOMMatrix(),
			ctx,
		);
		expect(relSegs[0].cp1.x).toBeCloseTo(absSegs[0].cp1.x);
		expect(relSegs[0].cp1.y).toBeCloseTo(absSegs[0].cp1.y);
		expect(relSegs[0].cp2.x).toBeCloseTo(absSegs[0].cp2.x);
		expect(relSegs[0].cp2.y).toBeCloseTo(absSegs[0].cp2.y);
	});
});

// --- parseSvgToArtObjects – rect ---

describe("parseSvgToArtObjects – rect", () => {
	it("converts <rect> with fill to a path with FillAppearance", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect x="10" y="20" width="100" height="50" fill="#ff0000"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;
		expect(path.type).toBe("path");
		expect(path.segments.length).toBeGreaterThan(0);

		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		expect(fill).toBeDefined();
		expect(fill?.paramData.params.fill.type).toBe("solid");
		if (fill?.paramData.params.fill.type === "solid") {
			expect(fill.paramData.params.fill.color.type).toBe("rgb");
		}
	});
});

// --- parseSvgToArtObjects – circle ---

describe("parseSvgToArtObjects – circle", () => {
	it("converts <circle> with stroke to a path with StrokeAppearance", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="40" fill="none" stroke="blue" stroke-width="2"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;
		// fill="none" → no FillAppearance
		const fill = path.filters?.find((f) => f.processor === "fill");
		expect(fill).toBeUndefined();

		const stroke = path.filters?.find((f) => f.processor === "stroke") as
			| StrokeAppearance
			| undefined;
		expect(stroke).toBeDefined();
		const sc = stroke?.paramData.params.strokeColor;
		expect(sc?.type).toBe("solid");
	});
});

// --- parseSvgToArtObjects – linearGradient fill ---

describe("parseSvgToArtObjects – linearGradient fill", () => {
	it("linearGradient fill → FillAppearance with type=linear, Y-axis flipped", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="red"/>
            <stop offset="1" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#g1)"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		expect(fill).toBeDefined();

		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("linear");
		if (fillColor?.type !== "linear") return;

		expect(fillColor.x1).toBeCloseTo(0);
		expect(fillColor.y1).toBeCloseTo(1); // 1 - 0 = 1 (Y-axis flip)
		expect(fillColor.x2).toBeCloseTo(1);
		expect(fillColor.y2).toBeCloseTo(1); // 1 - 0 = 1 (Y-axis flip)
		expect(fillColor.stops).toHaveLength(2);
	});
});

// --- parseSvgToArtObjects – radialGradient fill ---

describe("parseSvgToArtObjects – radialGradient fill", () => {
	it("radialGradient fill → FillAppearance with type=radial", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <radialGradient id="g2" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stop-color="white"/>
            <stop offset="1" stop-color="black"/>
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#g2)"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		expect(fill).toBeDefined();

		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("radial");
		if (fillColor?.type !== "radial") return;

		// cx=0.5, cy = 1-0.5 = 0.5 (symmetric so still 0.5 after flip)
		expect(fillColor.cx).toBeCloseTo(0.5);
		expect(fillColor.cy).toBeCloseTo(0.5);
	});
});

// --- parseSvgToArtObjects – userSpaceOnUse gradient ---

describe("parseSvgToArtObjects – userSpaceOnUse gradient", () => {
	it("userSpaceOnUse linear gradient is resolved against the element bbox, not the viewBox", async () => {
		// Rect at SVG (20,20)-(60,60) → world bbox x[-30,10] y[-10,30].
		// Gradient spans the rect horizontally in user space (x1=20 → x2=60).
		// Expected bbox-relative: start at left edge (x=0), end at right edge (x=1),
		// y constant at the top edge (world maxY → rel 1). The old viewBox-based
		// path would instead give x1=0.2, x2=0.6.
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="g3" gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="60" y2="20">
            <stop offset="0" stop-color="red"/>
            <stop offset="1" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="20" y="20" width="40" height="40" fill="url(#g3)"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("linear");
		if (fillColor?.type !== "linear") return;

		expect(fillColor.x1).toBeCloseTo(0);
		expect(fillColor.y1).toBeCloseTo(1);
		expect(fillColor.x2).toBeCloseTo(1);
		expect(fillColor.y2).toBeCloseTo(1);
	});

	it("stroke half-width expands the bbox used for userSpaceOnUse resolution (matches calculatePathBounds)", async () => {
		// Same rect + gradient, now with stroke-width 8 → the reference bbox grows
		// by 4 (half-width) on every side: x[-34,14], width 48. The gradient endpoints
		// at world x=-30 and x=10 then map to rel 4/48 and 44/48.
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="g4" gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="60" y2="20">
            <stop offset="0" stop-color="red"/>
            <stop offset="1" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="20" y="20" width="40" height="40" fill="url(#g4)" stroke="black" stroke-width="8"/>
      </svg>`,
			0,
			0,
		);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("linear");
		if (fillColor?.type !== "linear") return;

		expect(fillColor.x1).toBeCloseTo(4 / 48);
		expect(fillColor.x2).toBeCloseTo(44 / 48);
	});

	it("gradientTransform is applied to userSpaceOnUse coords before the element CTM", async () => {
		// Coords x1=100,x2=140 sit far outside the shape; translate(-80,0) brings
		// them onto the rect (→ 20 and 60), i.e. the rect's left and right edges.
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="g5" gradientUnits="userSpaceOnUse" gradientTransform="translate(-80 0)" x1="100" y1="20" x2="140" y2="20">
            <stop offset="0" stop-color="red"/>
            <stop offset="1" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="20" y="20" width="40" height="40" fill="url(#g5)"/>
      </svg>`,
			0,
			0,
		);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("linear");
		if (fillColor?.type !== "linear") return;

		expect(fillColor.x1).toBeCloseTo(0);
		expect(fillColor.x2).toBeCloseTo(1);
	});
});

// --- parseSvgToArtObjects – <pattern> fill ---

describe("parseSvgToArtObjects – <pattern> fill", () => {
	it("userSpaceOnUse pattern → DefEntry + PatternFill referencing it", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <pattern id="pat" patternUnits="userSpaceOnUse" x="0" y="0" width="10" height="10">
            <rect x="0" y="0" width="10" height="10" fill="red"/>
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#pat)"/>
      </svg>`,
			0,
			0,
		);

		expect(result.defs).toHaveLength(1);
		const def = result.defs[0];
		expect(def.kind).toBe("pattern");
		expect(def.tile).toEqual({ width: 10, height: 10 });
		expect(def.rootElementIds).toHaveLength(1);
		// Tile content lives in objects but is not referenced as a top-level element.
		expect(result.objects.has(def.rootElementIds[0])).toBe(true);
		expect(result.topLevelIds).not.toContain(def.rootElementIds[0]);

		expect(result.topLevelIds).toHaveLength(1);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		expect(fill).toBeDefined();

		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("pattern");
		if (fillColor?.type !== "pattern") return;
		expect(fillColor.defId).toBe(def.id);
	});

	it("objectBoundingBox pattern → no def, fill left empty", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <pattern id="pat2" width="0.1" height="0.1">
            <rect x="0" y="0" width="10" height="10" fill="red"/>
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#pat2)"/>
      </svg>`,
			0,
			0,
		);

		expect(result.defs).toHaveLength(0);
		expect(result.topLevelIds).toHaveLength(1);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const fill = path.filters?.find((f) => f.processor === "fill");
		expect(fill).toBeUndefined();
	});
});

// --- parseSvgToArtObjects – Y-axis conversion ---

describe("parseSvgToArtObjects – Y-axis conversion", () => {
	it("point at SVG (50, 75) maps to world (0, -25) when paste at origin", async () => {
		// viewBox 0 0 100 100 → center=(50,50)
		// SVG (50,75): x-50=0, -(75-50)=-25 → world(0,-25)
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <path d="M 50 75 L 50 75"/>
      </svg>`,
			0,
			0,
		);
		// The path has a degenerate segment (start=end), but let's check the coordinate
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		const seg = path.segments[0];
		expect(seg.start?.x ?? seg.end.x).toBeCloseTo(0);
		expect(seg.start?.y ?? seg.end.y).toBeCloseTo(-25);
	});

	it("pasteWorldX/Y offsets world position", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <path d="M 50 50 L 60 50"/>
      </svg>`,
			100,
			200,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		// SVG (50,50) = center → world offset = (100, 200)
		expect(path.segments[0].start?.x).toBeCloseTo(100);
		expect(path.segments[0].start?.y).toBeCloseTo(200);
	});
});

// --- parseSvgToArtObjects – <g> transform ---

describe("parseSvgToArtObjects – <g> transform", () => {
	it("translate transform on <g> shifts child segments", async () => {
		// Without transform: M 0 0 L 10 0 → start=world(-50,50), end=world(-40,50)
		// With translate(10,20): M 10 20 L 20 20 → start=world(-40,30), end=world(-30,30)
		const noTransformResult = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <path d="M 0 0 L 10 0"/>
      </svg>`,
			0,
			0,
		);
		const withTransformResult = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g transform="translate(10,20)"><path d="M 0 0 L 10 0"/></g>
      </svg>`,
			0,
			0,
		);

		expect(noTransformResult.topLevelIds).toHaveLength(1);
		expect(withTransformResult.topLevelIds).toHaveLength(1);

		const noId = noTransformResult.topLevelIds[0];
		const withId = withTransformResult.topLevelIds[0];
		const noPath = noTransformResult.objects.get(noId) as Path;
		const withPath = withTransformResult.objects.get(withId) as Path;

		const noSeg = noPath.segments[0];
		const withSeg = withPath.segments[0];

		// With translate(10,20): x shifts +10, y shifts -20 (Y-axis flip)
		expect(withSeg.start!.x).toBeCloseTo(noSeg.start!.x + 10);
		expect(withSeg.start!.y).toBeCloseTo(noSeg.start!.y - 20);
	});
});

// --- parseSvgToArtObjects – <g> group ---

describe("parseSvgToArtObjects – <g> group", () => {
	it("<g> with 2 children → Group object with childIds.length=2", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g>
          <rect x="0" y="0" width="10" height="10"/>
          <circle cx="50" cy="50" r="10"/>
        </g>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const group = result.objects.get(id) as Group;
		expect(group.type).toBe("group");
		expect(group.childIds).toHaveLength(2);
		const child0 = result.objects.get(group.childIds[0]);
		const child1 = result.objects.get(group.childIds[1]);
		expect(child0?.type).toBe("path");
		expect(child1?.type).toBe("path");
	});
});

// --- parseSvgToArtObjects – nested <g> ---

describe("parseSvgToArtObjects – nested <g>", () => {
	it("<g><g><rect/></g></g> → nested groups preserved", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g>
          <g>
            <rect x="0" y="0" width="10" height="10"/>
          </g>
        </g>
      </svg>`,
			0,
			0,
		);
		// Outer g contains inner g which contains rect.
		// Inner g has 1 child with opacity=1 and blendMode=normal, so it's collapsed to the path directly.
		// Outer g then has 1 child too, so it's also collapsed.
		// Result: topLevelIds contains the rect path id directly.
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const obj = result.objects.get(id);
		expect(obj?.type).toBe("path");
	});
});

// --- parseSvgToArtObjects – CSS class fill resolution ---

describe("parseSvgToArtObjects – CSS class fill resolution", () => {
	it("<style> class fill is applied to element with matching class attribute", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <style>.cls-1 { fill: #ff0000; }</style>
        <rect x="0" y="0" width="50" height="50" class="cls-1"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		expect(fill).toBeDefined();
		expect(fill?.paramData.params.fill.type).toBe("solid");
		if (fill?.paramData.params.fill.type !== "solid") return;
		const { color } = fill.paramData.params.fill;
		if (color.type !== "rgb") return;
		expect(color.r).toBeCloseTo(1);
		expect(color.g).toBeCloseTo(0);
		expect(color.b).toBeCloseTo(0);
	});

	it("<style> fill:none class suppresses FillAppearance", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <style>.cls-2 { fill: none; stroke: blue; stroke-width: 2; }</style>
        <circle cx="50" cy="50" r="20" class="cls-2"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		expect(path.filters?.find((f) => f.processor === "fill")).toBeUndefined();
		const stroke = path.filters?.find((f) => f.processor === "stroke") as
			| StrokeAppearance
			| undefined;
		expect(stroke).toBeDefined();
	});

	it("inline style overrides CSS class fill", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <style>.cls-3 { fill: #ff0000; }</style>
        <rect x="0" y="0" width="50" height="50" class="cls-3" style="fill: #0000ff;"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;

		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		expect(fill?.paramData.params.fill.type).toBe("solid");
		if (fill?.paramData.params.fill.type !== "solid") return;
		// inline style (#0000ff) wins over class (#ff0000)
		const { color } = fill.paramData.params.fill;
		if (color.type !== "rgb") return;
		expect(color.r).toBeCloseTo(0);
		expect(color.b).toBeCloseTo(1);
	});

	it("comma-separated selectors in <style> apply to all listed classes", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <style>.cls-4, .cls-5 { fill: #00ff00; }</style>
        <rect x="0" y="0" width="20" height="20" class="cls-4"/>
        <rect x="30" y="30" width="20" height="20" class="cls-5"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(2);
		for (const id of result.topLevelIds) {
			const path = result.objects.get(id) as Path;
			const fill = path.filters?.find((f) => f.processor === "fill") as
				| FillAppearance
				| undefined;
			expect(fill?.paramData.params.fill.type).toBe("solid");
			if (fill?.paramData.params.fill.type !== "solid") continue;
			const { color } = fill.paramData.params.fill;
			if (color.type !== "rgb") continue;
			expect(color.g).toBeCloseTo(1);
		}
	});
});

// --- parseSvgToArtObjects – clip-path ---

describe("parseSvgToArtObjects – clip-path", () => {
	it("<clipPath> via clip-path attribute → wrapper Group with clipPathId", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <clipPath id="cp1">
            <rect x="0" y="0" width="50" height="50"/>
          </clipPath>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="red" clip-path="url(#cp1)"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const wrapper = result.objects.get(id) as Group;
		expect(wrapper.type).toBe("group");
		expect(wrapper.clipPathId).toBeDefined();

		// clipPath shape and content should both be in objects map
		const clipShape = result.objects.get(wrapper.clipPathId!);
		expect(clipShape?.type).toBe("path");
	});

	it("clip-path via CSS class → wrapper Group with clipPathId", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <clipPath id="cp2">
            <rect x="0" y="0" width="50" height="50"/>
          </clipPath>
        </defs>
        <style>.cls-clip { clip-path: url(#cp2); fill: blue; }</style>
        <rect x="0" y="0" width="100" height="100" class="cls-clip"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const obj = result.objects.get(id) as Group;
		expect(obj.type).toBe("group");
		expect(obj.clipPathId).toBeDefined();
	});

	it("<g> with clip-path wraps entire group with clipPathId", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <clipPath id="cp3">
            <rect x="0" y="0" width="50" height="50"/>
          </clipPath>
        </defs>
        <g clip-path="url(#cp3)">
          <rect x="0" y="0" width="30" height="30" fill="red"/>
          <circle cx="50" cy="50" r="20" fill="blue"/>
        </g>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const wrapper = result.objects.get(id) as Group;
		expect(wrapper.type).toBe("group");
		expect(wrapper.clipPathId).toBeDefined();

		// clipPathId points to the clip shape
		const clipShape = result.objects.get(wrapper.clipPathId!);
		expect(clipShape?.type).toBe("path");
	});

	it("unknown clipPath id → returns plain node (no crash)", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect x="0" y="0" width="100" height="100" fill="red" clip-path="url(#nonexistent)"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const obj = result.objects.get(id);
		expect(obj?.type).toBe("path");
	});

	it("display:none via CSS class is skipped", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <style>.hidden { display: none; }</style>
        <rect x="0" y="0" width="50" height="50" fill="red"/>
        <rect x="50" y="50" width="50" height="50" fill="blue" class="hidden"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const obj = result.objects.get(id);
		expect(obj?.type).toBe("path");
	});
});

// --- parseSvgToArtObjects – mix-blend-mode ---

describe("parseSvgToArtObjects – mix-blend-mode", () => {
	it("mix-blend-mode via inline style → path.blendMode", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect x="0" y="0" width="50" height="50" fill="red" style="mix-blend-mode: hard-light;"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;
		expect(path.blendMode).toBe("hard-light");
	});

	it("mix-blend-mode via CSS class → path.blendMode", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <style>.cls-blend { mix-blend-mode: multiply; fill: blue; }</style>
        <rect x="0" y="0" width="50" height="50" class="cls-blend"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;
		expect(path.blendMode).toBe("multiply");
	});

	it("unknown blend mode → falls back to 'normal'", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect x="0" y="0" width="50" height="50" fill="red" style="mix-blend-mode: hue;"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const path = result.objects.get(id) as Path;
		expect(path.blendMode).toBe("normal");
	});
});

// --- parseSvgToArtObjects – <image> element ---

describe("parseSvgToArtObjects – <image> element", () => {
	// minimal 1x1 white PNG data URL
	const PNG_1X1 =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	it("<image> with data URL → ImageObject in objects map with correct mimeType", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
        <image x="10" y="20" width="60" height="40" xlink:href="${PNG_1X1}"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const imageObj = result.objects.get(id);
		expect(imageObj?.type).toBe("image");
		// width/height in world space should be > 0
		if (imageObj?.type !== "image") return;
		expect(imageObj.width).toBeGreaterThan(0);
		expect(imageObj.height).toBeGreaterThan(0);
		// Embedded file should be registered
		expect(result.files).toHaveLength(1);
		expect(result.files[0].type).toBe("image/png");
	});

	it("<image> with transform → world center is shifted", async () => {
		// Image at SVG (0,0) size 100x100, translated to (50,50) → SVG center = (100,100)
		// viewBox 0 0 200 200 → svgCenter=(100,100) → worldCenter=(0,0) + pasteOffset
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200">
        <image width="100" height="100" transform="translate(50,50)" xlink:href="${PNG_1X1}"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const id = result.topLevelIds[0];
		const imageObj = result.objects.get(id);
		if (imageObj?.type !== "image") return;

		// SVG center of image = translate(50,50) + (50,50) = (100,100)
		// viewBox center = (100,100), so world = (0, 0)
		expect(imageObj.x).toBeCloseTo(0);
		expect(imageObj.y).toBeCloseTo(0);
	});

	it("<image> with no href → skipped", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <image x="0" y="0" width="50" height="50"/>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(0);
	});
});

// --- parseSvgToArtObjects – <text> element ---

describe("parseSvgToArtObjects – <text> element", () => {
	it("single <text> → TextElement with world anchor, font-size, fill and content", async () => {
		// viewBox center (50,50); text at SVG (10,20) → world (-40, 30).
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <text x="10" y="20" font-size="32" fill="red" text-anchor="middle">Hi</text>
      </svg>`,
			0,
			0,
		);
		expect(result.topLevelIds).toHaveLength(1);
		const text = result.objects.get(result.topLevelIds[0]) as TextElement;
		expect(text.type).toBe("text");
		expect(text.x).toBeCloseTo(-40);
		expect(text.y).toBeCloseTo(30);
		expect(text.defaultStyle.fontSize).toBe(32);
		expect(text.defaultStyle.fill).toEqual({
			type: "solid",
			color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
		});

		const para = text.content.paragraphs[0];
		expect(para.alignment).toBe("center");
		expect(para.runs.map((r) => r.text).join("")).toBe("Hi");
	});

	it("<tspan> children become separate runs with per-span style overrides", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <text x="0" y="0" font-size="20"><tspan fill="red">A</tspan><tspan fill="blue" font-size="40">B</tspan></text>
      </svg>`,
			0,
			0,
		);
		const text = result.objects.get(result.topLevelIds[0]) as TextElement;
		const runs = text.content.paragraphs[0].runs;
		expect(runs).toHaveLength(2);
		expect(runs[0].text).toBe("A");
		expect(runs[0].style.fontSize).toBe(20);
		expect(runs[0].style.fill).toEqual({
			type: "solid",
			color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
		});
		expect(runs[1].text).toBe("B");
		expect(runs[1].style.fontSize).toBe(40);
		expect(runs[1].style.fill).toEqual({
			type: "solid",
			color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
		});
	});

	it("font-family is preserved and mapped to a google fontSource", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <text x="0" y="0" font-family="Roboto, sans-serif" font-weight="bold">X</text>
      </svg>`,
			0,
			0,
		);
		const text = result.objects.get(result.topLevelIds[0]) as TextElement;
		expect(text.defaultStyle.fontFamily).toBe("Roboto");
		expect(text.defaultStyle.fontWeight).toBe(700);
		expect(text.defaultStyle.fontSource).toEqual({
			type: "google",
			family: "Roboto",
			variants: ["700"],
		});
	});
});

// --- parseSvgToArtObjects – text writing-mode / dx / dy ---

describe("parseSvgToArtObjects – text writing-mode and dx/dy", () => {
	it("writing-mode maps to layout.writingMode", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <text x="0" y="0" writing-mode="vertical-rl">縦</text>
      </svg>`,
			0,
			0,
		);
		const text = result.objects.get(result.topLevelIds[0]) as TextElement;
		expect(text.layout.writingMode).toBe("vertical-rl");
	});

	it("element-level dx/dy shift the anchor", async () => {
		// center (50,50); anchor svg (10+5, 20-3)=(15,17) → world (-35, 33).
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <text x="10" y="20" dx="5" dy="-3">Hi</text>
      </svg>`,
			0,
			0,
		);
		const text = result.objects.get(result.topLevelIds[0]) as TextElement;
		expect(text.x).toBeCloseTo(-35);
		expect(text.y).toBeCloseTo(33);
	});
});

// --- parseSvgToArtObjects – filter effects ---

describe("parseSvgToArtObjects – filter effects", () => {
	it("feOffset+feFlood+feGaussianBlur → drop-shadow (Y-flipped offset)", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <filter id="ds">
            <feOffset dx="3" dy="5"/>
            <feFlood flood-color="red" flood-opacity="0.6"/>
            <feGaussianBlur stdDeviation="4"/>
          </filter>
        </defs>
        <rect x="10" y="10" width="20" height="20" fill="blue" filter="url(#ds)"/>
      </svg>`,
			0,
			0,
		);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const ds = path.filters?.find((f) => f.processor === "drop-shadow");
		expect(ds).toMatchObject({
			processor: "drop-shadow",
			paramData: {
				params: {
					offsetX: 3,
					offsetY: -5,
					blurRadius: 4,
					shadowOpacity: 0.6,
					shadowColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				},
			},
		});
	});

	it("lone feGaussianBlur → blur", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs><filter id="b"><feGaussianBlur stdDeviation="7"/></filter></defs>
        <rect x="0" y="0" width="20" height="20" fill="blue" filter="url(#b)"/>
      </svg>`,
			0,
			0,
		);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const blur = path.filters?.find((f) => f.processor === "blur");
		expect(blur).toMatchObject({
			processor: "blur",
			paramData: { params: { radius: 7 } },
		});
	});
});

// --- parseSvgToArtObjects – patternTransform ---

describe("parseSvgToArtObjects – patternTransform", () => {
	it("patternTransform decomposes into PatternFill scale/offset", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <pattern id="p" patternUnits="userSpaceOnUse" x="0" y="0" width="10" height="10" patternTransform="translate(4 6) scale(2)">
            <rect x="0" y="0" width="10" height="10" fill="red"/>
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#p)"/>
      </svg>`,
			0,
			0,
		);
		const path = result.objects.get(result.topLevelIds[0]) as Path;
		const fill = path.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		const fillColor = fill?.paramData.params.fill;
		expect(fillColor?.type).toBe("pattern");
		if (fillColor?.type !== "pattern") return;
		expect(fillColor.scaleX).toBeCloseTo(2);
		expect(fillColor.scaleY).toBeCloseTo(2);
		expect(fillColor.rotation).toBeCloseTo(0);
		expect(fillColor.offsetX).toBeCloseTo(4);
		expect(fillColor.offsetY).toBeCloseTo(-6);
	});
});

// --- parseSvgToArtObjects – empty/invalid SVG ---

describe("parseSvgToArtObjects – empty/invalid SVG", () => {
	it("empty string → empty result", async () => {
		const result = await parseSvgToArtObjects("", 0, 0);
		expect(result.topLevelIds).toEqual([]);
		expect(result.objects.size).toBe(0);
	});

	it("<svg/> with no shapes → empty result", async () => {
		const result = await parseSvgToArtObjects(
			`<svg xmlns="http://www.w3.org/2000/svg"/>`,
			0,
			0,
		);
		expect(result.topLevelIds).toEqual([]);
	});

	it("invalid XML → empty result", async () => {
		// parsererror element will be present
		const result = await parseSvgToArtObjects("<not-svg>", 0, 0);
		expect(result.topLevelIds).toEqual([]);
	});
});
