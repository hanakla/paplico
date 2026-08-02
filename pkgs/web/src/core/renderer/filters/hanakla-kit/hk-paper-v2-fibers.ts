import { tessellateStroke } from "../../geometry/strokeTessellator";
import type { HKPaperTypeDef } from "./hk-paper-v2-papers";

/**
 * CPU fiber planning for the hk:paper-v2 generator, ported from the original
 * ai-deno texture-paper-v2 planFibers/planJapanesePaperFiber. Planning runs
 * entirely in world px (no DPI anywhere): the GPU vertex shader maps world px
 * to texels, so the same plan renders identically at every rasterization DPI.
 *
 * Determinism contract: the SeededRandom draw ORDER is part of the output —
 * reordering or skipping draws changes every fiber and breaks VRT baselines.
 */

export interface FiberPlanInput {
	worldWidth: number;
	worldHeight: number;
	paper: HKPaperTypeDef;
	beatingDegree: number;
	fiberAmount: number;
	fiberDarkness: number;
	/** Absolute cap on fiber length in world px. */
	maxFiberLength: number;
	seed: number;
}

/** Runaway guard: onScaleFilter multiplies fiberAmount on export scaling. */
const MAX_PLANNED_FIBERS = 8000;

/**
 * Plan and tessellate every fiber into a single triangle-list vertex buffer:
 * 3 floats per vertex [worldX, worldY, gray(0-1)].
 */
export function buildFiberVertices(input: FiberPlanInput): Float32Array {
	const {
		worldWidth,
		worldHeight,
		paper,
		beatingDegree,
		fiberAmount,
		fiberDarkness,
		maxFiberLength,
		seed,
	} = input;

	if (worldWidth <= 0 || worldHeight <= 0) return new Float32Array(0);

	const random = new SeededRandom(seed);
	const out: number[] = [];

	const baseCount = 300 * fiberAmount;
	const fiberCount = Math.min(
		MAX_PLANNED_FIBERS,
		Math.floor(baseCount * (paper.fiberDensity * (0.5 + beatingDegree * 0.5))),
	);

	for (const fiber of paper.fibers) {
		const fiberTypeCount = Math.floor(fiberCount * fiber.ratio);
		const baseGray = Math.floor(250 - fiberDarkness * 100) + fiber.grayOffset;

		for (let i = 0; i < fiberTypeCount; i++) {
			const x = random.next() * worldWidth;
			const y = random.next() * worldHeight;
			const fiberLength = Math.min(
				paper.fiberLengthPx *
					(0.5 + random.next()) *
					(1 + (1 - beatingDegree) * 0.5),
				maxFiberLength,
			);
			const fiberWidth = 0.2 + (1 - beatingDegree) * 1.5;
			const angle = random.next() * Math.PI * (1 + (1 - beatingDegree));

			if (paper.japanesePaper) {
				planJapanesePaperFiber(
					out,
					x,
					y,
					fiberLength,
					fiberWidth,
					angle,
					random,
					baseGray,
					paper,
				);
			} else {
				const gray = Math.floor(baseGray - random.next() * 10);
				appendTaperedLine(
					out,
					x,
					y,
					x + Math.cos(angle) * fiberLength,
					y + Math.sin(angle) * fiberLength,
					fiberWidth * paper.baseWeight,
					gray,
					paper.weightVariation,
					random,
				);

				// Micro fibrils branching off well-beaten pulp fibers.
				if (beatingDegree > 0.5) {
					const microCount = Math.floor(beatingDegree * 8);
					for (let m = 0; m < microCount; m++) {
						const microLength = fiberLength * 0.2;
						const microAngle =
							angle + (random.next() - 0.5) * Math.PI * (1 - beatingDegree);
						const microGray = Math.floor(baseGray + 10 - random.next() * 10);
						appendTaperedLine(
							out,
							x,
							y,
							x + Math.cos(microAngle) * microLength,
							y + Math.sin(microAngle) * microLength,
							fiberWidth * 0.3 * paper.baseWeight,
							microGray,
							paper.weightVariation,
							random,
						);
					}
				}
			}
		}
	}

	return new Float32Array(out);
}

/** Deterministic PRNG ported verbatim from the original plugin. */
export class SeededRandom {
	private seed: number;

	public constructor(seed: number) {
		this.seed = seed;
	}

	public next(): number {
		const x = Math.sin(this.seed++) * 10000;
		return x - Math.floor(x);
	}
}

/** Long bast fiber: a wandering multi-segment main path with occasional
 *  branches and sub-branches, tapering from root to tip. */
function planJapanesePaperFiber(
	out: number[],
	x: number,
	y: number,
	baseLength: number,
	baseWidth: number,
	angle: number,
	random: SeededRandom,
	baseGray: number,
	paper: HKPaperTypeDef,
): void {
	const mainPath: number[] = [x, y];
	let currentAngle = angle;
	let currentX = x;
	let currentY = y;
	let currentWidth = baseWidth;
	let currentGray = baseGray - Math.floor(random.next() * 10);

	const segments = Math.floor(5 + random.next() * 5);
	const totalLength = baseLength * (1.5 + random.next());
	const segmentLength = totalLength / segments;

	for (let i = 0; i < segments; i++) {
		const thisSegmentLength = segmentLength * (0.8 + random.next() * 0.4);
		currentAngle += (random.next() - 0.5) * Math.PI * 0.3;

		currentGray += (random.next() - 0.5) * 20;
		currentGray = Math.max(baseGray - 30, Math.min(baseGray + 10, currentGray));

		currentX += Math.cos(currentAngle) * thisSegmentLength;
		currentY += Math.sin(currentAngle) * thisSegmentLength;
		mainPath.push(currentX, currentY);

		if (random.next() < 0.2 && mainPath.length > 2) {
			const branchAngle = currentAngle + (random.next() - 0.5) * Math.PI * 0.7;
			const branchLength = thisSegmentLength * (0.4 + random.next() * 0.8);
			const branchWidth = currentWidth * (0.5 + random.next() * 0.3);
			const branchX = currentX + Math.cos(branchAngle) * branchLength;
			const branchY = currentY + Math.sin(branchAngle) * branchLength;
			const branchGray = currentGray + (random.next() - 0.5) * 20;

			appendTaperedLine(
				out,
				currentX,
				currentY,
				branchX,
				branchY,
				branchWidth * paper.baseWeight,
				branchGray,
				paper.weightVariation,
				random,
			);

			if (random.next() < 0.3) {
				const subAngle = branchAngle + (random.next() - 0.5) * Math.PI * 0.5;
				const subLength = branchLength * 0.6;
				appendTaperedLine(
					out,
					branchX,
					branchY,
					branchX + Math.cos(subAngle) * subLength,
					branchY + Math.sin(subAngle) * subLength,
					branchWidth * 0.7 * paper.baseWeight,
					branchGray + 10,
					paper.weightVariation,
					random,
				);
			}
		}

		currentWidth *= 0.9 + random.next() * 0.2;
	}

	smoothPolyline(mainPath, paper.smoothingPasses);
	appendPolyline(
		out,
		mainPath,
		baseWidth * paper.baseWeight,
		currentGray,
		paper.weightVariation,
		random,
		// Root-to-tip taper of the original createJapaneseBranchPath.
		(t) => 0.2 + 0.8 * (1 - t) ** 0.7,
	);
}

/** Straight fiber sampled into >= 3 points with the original sin() taper. */
function appendTaperedLine(
	out: number[],
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	baseWidth: number,
	gray: number,
	weightVariation: number,
	random: SeededRandom,
): void {
	const dx = endX - startX;
	const dy = endY - startY;
	const length = Math.sqrt(dx * dx + dy * dy);
	const numPoints = Math.max(3, Math.floor(length / 8));
	const points: number[] = [];
	for (let i = 0; i < numPoints; i++) {
		const t = i / (numPoints - 1);
		points.push(startX + dx * t, startY + dy * t);
	}
	appendPolyline(
		out,
		points,
		baseWidth,
		gray,
		weightVariation,
		random,
		(t) => 0.3 + 0.7 * Math.sin(t * Math.PI),
	);
}

/** Tessellate one polyline (pressures encode the width profile) and append
 *  [x, y, gray] triangle vertices. */
function appendPolyline(
	out: number[],
	points: number[],
	baseWidth: number,
	gray: number,
	weightVariation: number,
	random: SeededRandom,
	taperProfile: (t: number) => number,
): void {
	const pointCount = points.length / 2;
	if (pointCount < 2) return;

	const pressures: number[] = [];
	for (let i = 0; i < pointCount; i++) {
		const t = i / (pointCount - 1);
		const jitter = 1 + weightVariation * (random.next() - 0.5) * 2;
		pressures.push(Math.max(0.05, taperProfile(t) * jitter));
	}

	const { vertices } = tessellateStroke({
		points,
		pressures,
		baseWidth,
		sizeByPressure: 1,
		lineCap: "round",
		lineJoin: "round",
		miterLimit: 4,
		isClosed: false,
	});

	const g = Math.min(255, Math.max(0, gray)) / 255;
	// Core vertices are [x, y, offsetX, offsetY]; the sub-pixel AA inset is
	// irrelevant for CPU fiber rasterization, so only positions are read.
	for (let i = 0; i < vertices.length; i += 4) {
		out.push(vertices[i], vertices[i + 1], g);
	}
}

/** Cheap stand-in for the original's svg-variable-width-line smoothing:
 *  moving-average passes over interior points. */
function smoothPolyline(points: number[], passes: number): void {
	const pointCount = points.length / 2;
	if (pointCount < 3) return;
	for (let pass = 0; pass < passes; pass++) {
		for (let i = 1; i < pointCount - 1; i++) {
			points[i * 2] =
				(points[(i - 1) * 2] + points[i * 2] * 2 + points[(i + 1) * 2]) / 4;
			points[i * 2 + 1] =
				(points[(i - 1) * 2 + 1] +
					points[i * 2 + 1] * 2 +
					points[(i + 1) * 2 + 1]) /
				4;
		}
	}
}
