import { describe, expect, it } from "vitest";
import type {
	BoundingBox,
	CubicBezierSegment,
	Path,
	TextContent,
	TextLayout,
	TextStyle,
} from "../../schema";
import { computeInverseCompositionTransform } from "./geometry";
import {
	createScaleTransform,
	scaleSegments,
	scaleTextContent,
	scaleTextLayout,
	scaleTextStyle,
} from "./resize";
import { getWorldSegments, toWorldPath } from "./segmentOps";

// --- Helpers ---

function makeBounds(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function makeTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
	return {
		fontFamily: "Arial",
		fontSource: { type: "google", family: "Arial", variants: ["regular"] },
		fontSize: 24,
		fontWeight: 400,
		fontStyle: "normal",
		fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
		...overrides,
	};
}

function makeTextContent(
	runs: Array<{ text: string; style?: Partial<TextStyle> }>,
): TextContent {
	return {
		paragraphs: [
			{
				runs: runs.map((r) => ({
					text: r.text,
					style: makeTextStyle(r.style),
				})),
				alignment: "left" as const,
				lineHeight: 1.2,
				indent: 0,
				spacing: { before: 0, after: 0 },
			},
		],
	};
}

// --- Tests ---

describe("scaleTextStyle", () => {
	it("should scale fontSize by the uniform factor", () => {
		const style = makeTextStyle({ fontSize: 24 });
		const result = scaleTextStyle(style, 2);
		expect(result.fontSize).toBe(48);
	});

	it("should scale strokeWidth when present", () => {
		const style = makeTextStyle({ fontSize: 16, strokeWidth: 2 });
		const result = scaleTextStyle(style, 1.5);
		expect(result.fontSize).toBe(24);
		expect(result.strokeWidth).toBe(3);
	});

	it("should leave strokeWidth undefined when absent", () => {
		const style = makeTextStyle({ fontSize: 16, strokeWidth: undefined });
		const result = scaleTextStyle(style, 2);
		expect(result.strokeWidth).toBeUndefined();
	});

	it("should not mutate the original style", () => {
		const style = makeTextStyle({ fontSize: 20 });
		scaleTextStyle(style, 3);
		expect(style.fontSize).toBe(20);
	});

	it("should preserve non-scaled properties", () => {
		const style = makeTextStyle({
			fontFamily: "Noto Sans JP",
			fontWeight: 700,
			fontStyle: "italic",
			letterSpacing: 0.05,
			underline: true,
		});
		const result = scaleTextStyle(style, 2);
		expect(result.fontFamily).toBe("Noto Sans JP");
		expect(result.fontWeight).toBe(700);
		expect(result.fontStyle).toBe("italic");
		expect(result.letterSpacing).toBe(0.05);
		expect(result.underline).toBe(true);
	});

	it("should handle scale factor < 1 (shrink)", () => {
		const style = makeTextStyle({ fontSize: 48 });
		const result = scaleTextStyle(style, 0.5);
		expect(result.fontSize).toBe(24);
	});
});

describe("scaleTextContent", () => {
	it("should scale fontSize of all runs in all paragraphs", () => {
		const content = makeTextContent([
			{ text: "Hello", style: { fontSize: 24 } },
			{ text: " World", style: { fontSize: 36 } },
		]);
		const result = scaleTextContent(content, 2);

		expect(result.paragraphs[0].runs[0].style.fontSize).toBe(48);
		expect(result.paragraphs[0].runs[1].style.fontSize).toBe(72);
	});

	it("should scale strokeWidth in runs that have it", () => {
		const content = makeTextContent([
			{ text: "A", style: { fontSize: 20, strokeWidth: 1 } },
			{ text: "B", style: { fontSize: 20, strokeWidth: undefined } },
		]);
		const result = scaleTextContent(content, 3);

		expect(result.paragraphs[0].runs[0].style.strokeWidth).toBe(3);
		expect(result.paragraphs[0].runs[1].style.strokeWidth).toBeUndefined();
	});

	it("should not mutate the original content", () => {
		const content = makeTextContent([
			{ text: "Test", style: { fontSize: 16 } },
		]);
		scaleTextContent(content, 5);
		expect(content.paragraphs[0].runs[0].style.fontSize).toBe(16);
	});

	it("should preserve run text", () => {
		const content = makeTextContent([
			{ text: "あいう", style: { fontSize: 12 } },
		]);
		const result = scaleTextContent(content, 2);
		expect(result.paragraphs[0].runs[0].text).toBe("あいう");
	});

	it("should handle multiple paragraphs", () => {
		const content: TextContent = {
			paragraphs: [
				{
					runs: [{ text: "P1", style: makeTextStyle({ fontSize: 10 }) }],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
				{
					runs: [{ text: "P2", style: makeTextStyle({ fontSize: 20 }) }],
					alignment: "center",
					lineHeight: 1.5,
					indent: 10,
					spacing: { before: 4, after: 8 },
				},
			],
		};
		const result = scaleTextContent(content, 2);
		expect(result.paragraphs[0].runs[0].style.fontSize).toBe(20);
		expect(result.paragraphs[1].runs[0].style.fontSize).toBe(40);
		// paragraph-level properties are preserved
		expect(result.paragraphs[1].alignment).toBe("center");
		expect(result.paragraphs[1].indent).toBe(10);
	});
});

describe("scaleTextLayout", () => {
	it("should scale numeric boxWidth/boxHeight", () => {
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: 200,
			boxHeight: 100,
			overflow: "visible",
			wordWrap: true,
		};
		const original = makeBounds(0, 0, 200, 100);
		const newBounds = makeBounds(0, 0, 400, 300);
		const transform = createScaleTransform(original, newBounds);

		const result = scaleTextLayout(layout, transform, newBounds);
		expect(result.boxWidth).toBe(400); // 200 * 2.0
		expect(result.boxHeight).toBe(300); // 100 * 3.0
	});

	it("should set boxWidth/boxHeight from newBounds when originally 'auto'", () => {
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: true,
		};
		const original = makeBounds(0, 0, 200, 100);
		const newBounds = makeBounds(10, 20, 310, 220);
		const transform = createScaleTransform(original, newBounds);

		const result = scaleTextLayout(layout, transform, newBounds);
		expect(result.boxWidth).toBe(300); // newBounds.width
		expect(result.boxHeight).toBe(200); // newBounds.height
	});

	it("should preserve non-layout properties", () => {
		const layout: TextLayout = {
			writingMode: "vertical-rl",
			boxWidth: 100,
			boxHeight: 200,
			overflow: "hidden",
			wordWrap: false,
		};
		const original = makeBounds(0, 0, 100, 200);
		const newBounds = makeBounds(0, 0, 200, 400);
		const transform = createScaleTransform(original, newBounds);

		const result = scaleTextLayout(layout, transform, newBounds);
		expect(result.writingMode).toBe("vertical-rl");
		expect(result.overflow).toBe("hidden");
		expect(result.wordWrap).toBe(false);
	});

	it("should not mutate the original layout", () => {
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: 100,
			boxHeight: 50,
			overflow: "visible",
			wordWrap: true,
		};
		const original = makeBounds(0, 0, 100, 50);
		const newBounds = makeBounds(0, 0, 300, 150);
		const transform = createScaleTransform(original, newBounds);

		scaleTextLayout(layout, transform, newBounds);
		expect(layout.boxWidth).toBe(100);
		expect(layout.boxHeight).toBe(50);
	});
});

describe("text resize integration", () => {
	it("uniform scale: 2x enlargement should double fontSize", () => {
		const original = makeBounds(0, 0, 100, 100);
		const scaled = makeBounds(0, 0, 200, 200);
		const transform = createScaleTransform(original, scaled);
		const uniformScale = Math.sqrt(transform.scaleX * transform.scaleY);

		expect(uniformScale).toBe(2);

		const style = makeTextStyle({ fontSize: 16 });
		const result = scaleTextStyle(style, uniformScale);
		expect(result.fontSize).toBe(32);
	});

	it("non-uniform scale: geometric mean of scaleX and scaleY", () => {
		const original = makeBounds(0, 0, 100, 100);
		const scaled = makeBounds(0, 0, 400, 100); // 4x horizontal, 1x vertical
		const transform = createScaleTransform(original, scaled);
		const uniformScale = Math.sqrt(transform.scaleX * transform.scaleY);

		expect(uniformScale).toBe(2); // sqrt(4 * 1) = 2

		const style = makeTextStyle({ fontSize: 12 });
		const result = scaleTextStyle(style, uniformScale);
		expect(result.fontSize).toBe(24);
	});

	it("shrink to half: fontSize should halve", () => {
		const original = makeBounds(0, 0, 200, 200);
		const scaled = makeBounds(0, 0, 100, 100);
		const transform = createScaleTransform(original, scaled);
		const uniformScale = Math.sqrt(transform.scaleX * transform.scaleY);

		expect(uniformScale).toBe(0.5);

		const style = makeTextStyle({ fontSize: 48 });
		const result = scaleTextStyle(style, uniformScale);
		expect(result.fontSize).toBe(24);
	});

	it("full text element resize: position, layout, style, and content all scale correctly", () => {
		const original = makeBounds(50, 50, 250, 150);
		const newBounds = makeBounds(50, 50, 450, 250);
		const transform = createScaleTransform(original, newBounds);
		const uniformScale = Math.sqrt(transform.scaleX * transform.scaleY);

		// Position mapping: element at center of original bounds
		const origX = 150; // center of [50, 250]
		const origY = 100; // center of [50, 150]
		expect(transform.mapX(origX)).toBe(250); // 50 + (150-50)*2 = 250
		expect(transform.mapY(origY)).toBe(150); // 50 + (100-50)*2 = 150

		// Layout
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: 200,
			boxHeight: 100,
			overflow: "visible",
			wordWrap: true,
		};
		const scaledLayout = scaleTextLayout(layout, transform, newBounds);
		expect(scaledLayout.boxWidth).toBe(400); // 200 * 2
		expect(scaledLayout.boxHeight).toBe(200); // 100 * 2

		// Style: uniformScale = sqrt(2*2) = 2
		expect(uniformScale).toBe(2);
		const style = makeTextStyle({ fontSize: 16, strokeWidth: 1 });
		const scaledStyle = scaleTextStyle(style, uniformScale);
		expect(scaledStyle.fontSize).toBe(32);
		expect(scaledStyle.strokeWidth).toBe(2);

		// Content
		const content = makeTextContent([
			{ text: "Hello", style: { fontSize: 24 } },
		]);
		const scaledContent = scaleTextContent(content, uniformScale);
		expect(scaledContent.paragraphs[0].runs[0].style.fontSize).toBe(48);
	});
});

describe("resize commit under a transformed ancestor", () => {
	// Mirrors Paplico.applyElementResize's path branch: bake to world through
	// the ancestor transform, scale in world space, then store the ancestor's
	// inverse as the path transform so the renderer's re-applied ancestor
	// transform cancels out.
	it("should land the scaled path exactly where the world-space map put it", () => {
		const ancestorT = {
			x: 40,
			y: -25,
			rotation: Math.PI / 6,
			scaleX: 1.5,
			scaleY: 0.8,
			skewX: 0,
			skewY: 0,
		};
		const path = makePath();

		const worldPath = toWorldPath(path, ancestorT);
		const originalBounds = makeBounds(-100, -100, 100, 100);
		const newBounds = makeBounds(-100, -100, 300, 300);
		const map = createScaleTransform(originalBounds, newBounds);

		const committed: Path = {
			...path,
			segments: scaleSegments(worldPath.segments, map),
			transform: computeInverseCompositionTransform(ancestorT),
		};

		const rendered = getWorldSegments(committed, ancestorT);
		const expected = committed.segments;

		for (let i = 0; i < expected.length; i++) {
			const expectedStart = expected[i].start;
			if (expectedStart) {
				expect(rendered[i].start?.x).toBeCloseTo(expectedStart.x, 6);
				expect(rendered[i].start?.y).toBeCloseTo(expectedStart.y, 6);
			}
			expect(rendered[i].end.x).toBeCloseTo(expected[i].end.x, 6);
			expect(rendered[i].end.y).toBeCloseTo(expected[i].end.y, 6);
		}
	});
});

function makePath(): Path {
	const segments: CubicBezierSegment[] = [
		{
			start: { x: 10, y: 20 },
			cp1: { x: 35, y: -8 },
			cp2: { x: -24, y: 14 },
			end: { x: 80, y: 50 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
		},
		{
			cp1: { x: 12, y: -5 },
			cp2: { x: -16, y: 9 },
			end: { x: 120, y: 85 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: false,
		},
	];

	return {
		type: "path",
		id: "path-1",
		opacity: 1,
		blendMode: "normal",
		transform: {
			x: 15,
			y: -10,
			rotation: 0.2,
			scaleX: 1,
			scaleY: 1,
			skewX: 0,
			skewY: 0,
		},
		segments,
	};
}
