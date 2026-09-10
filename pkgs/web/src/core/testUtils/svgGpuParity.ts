import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { PaplicoSVGExporter } from "../io/export/PaplicoSVGExporter";
import type { RenderOrchestrator } from "../renderer/RenderOrchestrator";
import type { Artboard, Document } from "../schema";
import { expectPngBufferMatch } from "./visualRegression";

/**
 * Export `artboard` to SVG, rasterize it with resvg and compare against the
 * GPU render of the same artboard. `maxDiffPercentage` is measured against
 * the GPU render's CONTENT pixels; sub-pixel edge shifts are excluded by the
 * nearby-match pass. With `baseline` the resvg rasterization is also tracked
 * as a checked-in PNG named `svg-export-${name}`.
 */
export async function expectSvgMatchesGpu(
	renderer: RenderOrchestrator,
	artboard: Artboard,
	doc: Document,
	name: string,
	maxDiffPercentage: number,
	{ baseline = true }: { baseline?: boolean } = {},
): Promise<void> {
	const white = { r: 1, g: 1, b: 1, a: 1 };
	const testName = `svg-vs-gpu-${name}`;

	const gpu = await renderer.renderArtboardToImageData(artboard, doc, 1, white);
	if (!gpu) throw new Error("GPU render failed");

	const exporter = new PaplicoSVGExporter(renderer, () => doc);
	const result = await exporter.renderArtboardToSVG(artboard.id, {
		backgroundColor: white,
	});
	if (!result) throw new Error("SVG export failed");

	const svgPngBuffer = Buffer.from(
		new Resvg(result.svg, {
			fitTo: { mode: "width", value: gpu.width },
		})
			.render()
			.asPng(),
	);
	const svgPng = PNG.sync.read(svgPngBuffer);

	// Baseline VRT of the resvg rasterization itself: pixel-tight regression
	// tracking of the SVG output, independent of the looser GPU tolerance.
	if (baseline) expectPngBufferMatch(svgPngBuffer, `svg-export-${name}`);

	// Fractional artboard sizes may round one pixel apart between the two
	// rasterizers; anything larger is a real geometry bug.
	if (
		Math.abs(svgPng.width - gpu.width) > 1 ||
		Math.abs(svgPng.height - gpu.height) > 1
	) {
		throw new Error(
			`SVG/GPU size mismatch: svg ${svgPng.width}x${svgPng.height} vs gpu ${gpu.width}x${gpu.height}`,
		);
	}

	const width = Math.min(svgPng.width, gpu.width);
	const height = Math.min(svgPng.height, gpu.height);
	const svgPixels = cropRgba(svgPng.data, svgPng.width, width, height);
	const gpuPixels = cropRgba(gpu.data, gpu.width, width, height);

	const diff = new PNG({ width, height });
	pixelmatch(svgPixels, gpuPixels, diff.data, width, height, {
		threshold: 0.15,
	});
	// Two-stage judgement: a raw pixelmatch diff that has a matching color
	// within 1px in BOTH directions is a sub-pixel edge shift (outlined text
	// AA vs the GPU's text rendering) — content that is simply MISSING on one
	// side has no nearby match and stays a real difference.
	let realDiffPixels = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			// pixelmatch writes red (255,0,0) into flagged pixels.
			if (!(diff.data[i] === 255 && diff.data[i + 1] === 0)) continue;
			if (
				!hasNearbyMatch(gpuPixels, svgPixels, x, y, width, height) ||
				!hasNearbyMatch(svgPixels, gpuPixels, x, y, width, height)
			) {
				realDiffPixels++;
			} else {
				// Downgrade shifted-edge pixels in the saved diff for eyeballing.
				diff.data[i] = 255;
				diff.data[i + 1] = 220;
				diff.data[i + 2] = 0;
			}
		}
	}
	// Measure against the CONTENT the GPU actually painted, not the canvas
	// area: on a mostly-empty artboard a whole-canvas percentage hides a
	// completely broken element inside the whitespace.
	let contentPixels = 0;
	for (let i = 0; i < gpuPixels.length; i += 4) {
		if (
			!(gpuPixels[i] > 245 && gpuPixels[i + 1] > 245 && gpuPixels[i + 2] > 245)
		) {
			contentPixels++;
		}
	}
	const diffPercentage = (realDiffPixels / Math.max(contentPixels, 1)) * 100;

	const diffDir = join(__dirname, "../../__visual_diffs__");
	if (diffPercentage <= maxDiffPercentage) {
		for (const suffix of [".svg.png", ".gpu.png", ".diff.png", ".svg"]) {
			const stale = join(diffDir, `${testName}${suffix}`);
			if (existsSync(stale)) unlinkSync(stale);
		}
		return;
	}
	mkdirSync(diffDir, { recursive: true });
	const svgOut = new PNG({ width, height });
	svgOut.data = Buffer.from(svgPixels);
	const gpuOut = new PNG({ width, height });
	gpuOut.data = Buffer.from(gpuPixels);
	writeFileSync(join(diffDir, `${testName}.svg.png`), PNG.sync.write(svgOut));
	writeFileSync(join(diffDir, `${testName}.gpu.png`), PNG.sync.write(gpuOut));
	writeFileSync(join(diffDir, `${testName}.diff.png`), PNG.sync.write(diff));
	writeFileSync(join(diffDir, `${testName}.svg`), result.svg);
	throw new Error(
		`SVG export diverges from the GPU render: ${realDiffPixels} of ${contentPixels} content pixels differ ` +
			`(${diffPercentage.toFixed(2)}% > ${maxDiffPercentage}%, edge shifts excluded)\n` +
			`SVG rendering / diff saved under: ${diffDir}/${testName}.*`,
	);
}

/**
 * True when `expected`'s pixel at (x, y) has a color within pixelmatch-like
 * tolerance somewhere in `actual`'s 3×3 neighborhood — i.e. the flagged pixel
 * is explained by a ≤1px edge shift rather than by missing content.
 */
function hasNearbyMatch(
	expected: Uint8Array,
	actual: Uint8Array,
	x: number,
	y: number,
	width: number,
	height: number,
): boolean {
	const e = (y * width + x) * 4;
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
			const a = (ny * width + nx) * 4;
			// 96 also absorbs the AA-density gap between the GPU's text
			// compositing and resvg's path AA (same coverage renders ~60 apart),
			// while missing content against the background stays >96 apart.
			if (
				Math.abs(expected[e] - actual[a]) < 96 &&
				Math.abs(expected[e + 1] - actual[a + 1]) < 96 &&
				Math.abs(expected[e + 2] - actual[a + 2]) < 96
			) {
				return true;
			}
		}
	}
	return false;
}

function cropRgba(
	data: Uint8Array | Uint8ClampedArray | Buffer,
	sourceWidth: number,
	width: number,
	height: number,
): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const src = y * sourceWidth * 4;
		out.set(data.subarray(src, src + width * 4), y * width * 4);
	}
	return out;
}
