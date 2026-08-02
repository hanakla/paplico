import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CubicBezierSegment } from "../schema";
import { resolveSegment } from "../utils/geometry/segmentOps";

const PADDING = 16;

interface RenderOptions {
	fillColor?: string;
	strokeColor?: string;
	strokeWidth?: number;
}

/**
 * Compute axis-aligned bounding box from resolved segment control points.
 */
function computeSegmentsBBox(segments: CubicBezierSegment[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(segments[i], prevEnd);
		for (const pt of [r.start, r.cp1, r.cp2, r.end]) {
			minX = Math.min(minX, pt.x);
			minY = Math.min(minY, pt.y);
			maxX = Math.max(maxX, pt.x);
			maxY = Math.max(maxY, pt.y);
		}
	}

	return { minX, minY, maxX, maxY };
}

/**
 * Render CubicBezierSegments to RGBA pixel data.
 *
 * BBox is auto-computed from segments. Canvas size = ceil(BBox) + 16px padding on each side.
 * World-space Y-up is flipped to Canvas Y-down.
 */
export function renderSegmentsToPixels(
	segments: CubicBezierSegment[],
	options?: RenderOptions,
	overrideBBox?: { minX: number; minY: number; maxX: number; maxY: number },
): { data: Uint8Array; width: number; height: number } {
	const { fillColor = "#000000", strokeColor, strokeWidth = 1 } = options ?? {};

	const bbox = overrideBBox ?? computeSegmentsBBox(segments);
	const bboxW = Math.ceil(bbox.maxX - bbox.minX);
	const bboxH = Math.ceil(bbox.maxY - bbox.minY);
	const width = Math.max(1, bboxW + PADDING * 2);
	const height = Math.max(1, bboxH + PADDING * 2);

	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	// White background
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);

	// Draw path
	ctx.beginPath();
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(seg, prevEnd);

		// World → Canvas transform (Y-flip)
		const sx = r.start.x - bbox.minX + PADDING;
		const sy = bbox.maxY - r.start.y + PADDING;
		const c1x = r.cp1.x - bbox.minX + PADDING;
		const c1y = bbox.maxY - r.cp1.y + PADDING;
		const c2x = r.cp2.x - bbox.minX + PADDING;
		const c2y = bbox.maxY - r.cp2.y + PADDING;
		const ex = r.end.x - bbox.minX + PADDING;
		const ey = bbox.maxY - r.end.y + PADDING;

		if (seg.isMoved || i === 0) {
			ctx.moveTo(sx, sy);
		}
		ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
		if (seg.isClosed) {
			ctx.closePath();
		}
	}

	ctx.fillStyle = fillColor;
	ctx.fill();

	if (strokeColor) {
		ctx.strokeStyle = strokeColor;
		ctx.lineWidth = strokeWidth;
		ctx.stroke();
	}

	const imageData = ctx.getImageData(0, 0, width, height);
	return {
		data: new Uint8Array(imageData.data),
		width,
		height,
	};
}

/** Derive a filesystem-safe name from the current test's call stack. */
function inferTestName(): string {
	const stack = new Error().stack ?? "";
	const lines = stack.split("\n");
	for (const line of lines) {
		// Match vitest test runner frames like "at /path/to/file.test.ts:123:45"
		const m = line.match(/at\s+.*?([^/\\]+\.test\.[tj]sx?):(\d+)/);
		if (m) return `${m[1].replace(/\.[tj]sx?$/, "")}-L${m[2]}`;
	}
	return `unknown-${Date.now()}`;
}

const VISUAL_TEMP_DIR = path.resolve(__dirname, "../../__visual_temp__");

function writeDiffPNG(
	imgA: { data: Uint8Array; width: number; height: number },
	imgB: { data: Uint8Array; width: number; height: number },
	diffData: Uint8Array,
	testName: string,
): string {
	if (!fs.existsSync(VISUAL_TEMP_DIR))
		fs.mkdirSync(VISUAL_TEMP_DIR, { recursive: true });

	const w = imgA.width;
	const h = imgA.height;

	// Write: actual (A), expected (B), diff side by side
	for (const [suffix, data] of [
		["actual", imgA.data],
		["expected", imgB.data],
		["diff", diffData],
	] as const) {
		const png = new PNG({ width: w, height: h });
		png.data = Buffer.from(data);
		const filePath = path.join(VISUAL_TEMP_DIR, `${testName}.${suffix}.png`);
		fs.writeFileSync(filePath, PNG.sync.write(png));
	}

	return VISUAL_TEMP_DIR;
}

/**
 * Compare two segment arrays visually (in-memory, no snapshot files).
 * Renders both with a unified BBox so they occupy the same canvas region,
 * then compares pixels with pixelmatch.
 *
 * On mismatch, writes actual/expected/diff PNGs to src/__visual_temp__/.
 * File names are auto-derived from the calling test's stack trace.
 */
export function expectSegmentsVisualMatch(
	a: CubicBezierSegment[],
	b: CubicBezierSegment[],
	options?: {
		fillColor?: string;
		strokeColor?: string;
		strokeWidth?: number;
		pixelThreshold?: number;
		maxDiffPercentage?: number;
	},
): void {
	const {
		fillColor,
		strokeColor,
		strokeWidth,
		pixelThreshold = 0.1,
		maxDiffPercentage = 0,
	} = options ?? {};

	const bboxA = computeSegmentsBBox(a);
	const bboxB = computeSegmentsBBox(b);
	const unifiedBBox = {
		minX: Math.min(bboxA.minX, bboxB.minX),
		minY: Math.min(bboxA.minY, bboxB.minY),
		maxX: Math.max(bboxA.maxX, bboxB.maxX),
		maxY: Math.max(bboxA.maxY, bboxB.maxY),
	};

	const renderOpts: RenderOptions = { fillColor, strokeColor, strokeWidth };
	const imgA = renderSegmentsToPixels(a, renderOpts, unifiedBBox);
	const imgB = renderSegmentsToPixels(b, renderOpts, unifiedBBox);

	const diffBuf = new Uint8Array(imgA.width * imgA.height * 4);
	const totalPixels = imgA.width * imgA.height;
	const diffPixels = pixelmatch(
		imgA.data,
		imgB.data,
		diffBuf,
		imgA.width,
		imgA.height,
		{ threshold: pixelThreshold },
	);

	const diffPercentage = (diffPixels / totalPixels) * 100;
	if (diffPercentage > maxDiffPercentage) {
		const testName = inferTestName();
		const outDir = writeDiffPNG(imgA, imgB, diffBuf, testName);
		throw new Error(
			`Visual mismatch: ${diffPixels}/${totalPixels} pixels differ ` +
				`(${diffPercentage.toFixed(2)}% > ${maxDiffPercentage}%)\n` +
				`Diff saved to: ${outDir}/${testName}.*.png`,
		);
	}
}

/**
 * Compare rendered segments against a snapshot PNG file.
 * On first run (no baseline), saves the baseline.
 * On subsequent runs, compares against the baseline.
 * Set UPDATE_BASELINES=true to overwrite existing baselines.
 *
 * Snapshot files are stored next to the calling test file in a
 * `__snapshots__` directory, named `<testFile>-<snapshotName>.snap.png`.
 */
export function expectSegmentsMatchSnapshot(
	segments: CubicBezierSegment[],
	snapshotName: string,
	options?: {
		fillColor?: string;
		pixelThreshold?: number;
		maxDiffPercentage?: number;
	},
): void {
	const {
		fillColor,
		pixelThreshold = 0.1,
		maxDiffPercentage = 0,
	} = options ?? {};

	// Same directory as WebGPU VRT baselines
	const baselineDir = path.join(__dirname, "../../__visual_baselines__");
	if (!fs.existsSync(baselineDir))
		fs.mkdirSync(baselineDir, { recursive: true });

	const safeName = snapshotName.replace(/[^a-zA-Z0-9_-]/g, "_");
	const snapshotPath = path.join(baselineDir, `${safeName}.png`);

	const img = renderSegmentsToPixels(segments, { fillColor });
	const updateBaselines = process.env.UPDATE_BASELINES === "true";

	if (!fs.existsSync(snapshotPath) || updateBaselines) {
		const png = new PNG({ width: img.width, height: img.height });
		png.data = Buffer.from(img.data);
		fs.writeFileSync(snapshotPath, PNG.sync.write(png));
		if (!updateBaselines) return; // first run: save and pass
	}

	// Load baseline
	const baselineBuf = fs.readFileSync(snapshotPath);
	const baseline = PNG.sync.read(baselineBuf);

	// If dimensions differ, fail immediately
	if (baseline.width !== img.width || baseline.height !== img.height) {
		throw new Error(
			`Snapshot dimension mismatch: actual ${img.width}×${img.height} vs baseline ${baseline.width}×${baseline.height}. ` +
				`Run with UPDATE_BASELINES=true to update.`,
		);
	}

	const diffBuf = new Uint8Array(img.width * img.height * 4);
	const totalPixels = img.width * img.height;
	const diffPixels = pixelmatch(
		img.data,
		new Uint8Array(baseline.data),
		diffBuf,
		img.width,
		img.height,
		{ threshold: pixelThreshold },
	);

	const diffPercentage = (diffPixels / totalPixels) * 100;
	if (diffPercentage > maxDiffPercentage) {
		// Write actual + diff to __visual_temp__
		const testName = inferTestName();
		writeDiffPNG(
			img,
			{
				data: new Uint8Array(baseline.data),
				width: baseline.width,
				height: baseline.height,
			},
			diffBuf,
			testName,
		);
		throw new Error(
			`Snapshot mismatch for "${snapshotName}": ${diffPixels}/${totalPixels} pixels differ ` +
				`(${diffPercentage.toFixed(2)}% > ${maxDiffPercentage}%)\n` +
				`Baseline: ${snapshotPath}\n` +
				`Diff saved to: ${VISUAL_TEMP_DIR}/${testName}.*.png\n` +
				`Run with UPDATE_BASELINES=true to update.`,
		);
	}
}

/** Save rendered segments as a PNG file. */
export function saveSegmentsPNG(
	segments: CubicBezierSegment[],
	filePath: string,
	options?: RenderOptions,
	overrideBBox?: { minX: number; minY: number; maxX: number; maxY: number },
): void {
	const img = renderSegmentsToPixels(segments, options, overrideBBox);
	const png = new PNG({ width: img.width, height: img.height });
	png.data = Buffer.from(img.data);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, PNG.sync.write(png));
}
