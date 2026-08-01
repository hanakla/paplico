import { describe, expect, it } from "vitest";
import { maskToPath } from "./maskToPath";
import { createRasterSpace } from "./rasterSpace";

const defaultFill = {
	type: "solid" as const,
	color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 },
};

function maxEndX(segments: Array<{ end: { x: number } }>): number {
	return Math.max(...segments.map((s) => s.end.x));
}

describe("maskToPath sub-pixel contour", () => {
	// 20×20 raster at scale 1, world = raster - 10. A black rectangle spans
	// x 2..9; column 10 is an anti-aliased edge pixel whose colour distance
	// (120) lies just beyond the tolerance (100); x ≥ 11 is a white barrier.
	const W = 20;
	const H = 20;
	const space = createRasterSpace(
		{ centerX: 0, centerY: 0, worldWidth: W, worldHeight: H },
		1,
	);
	const seedColor = { r: 0, g: 0, b: 0, a: 255 };

	function buildScene() {
		const data = new Uint8ClampedArray(W * H * 4);
		const mask = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				const inRegion = x >= 2 && x <= 9 && y >= 2 && y <= 17;
				const isAA = x === 10 && y >= 2 && y <= 17;
				if (inRegion) {
					data[i + 3] = 255; // black, matches seed
					mask[y * W + x] = 1;
				} else if (isAA) {
					data[i] = 120; // diff 120 vs tolerance 100 → graded field
					data[i + 3] = 255;
				} else {
					data[i] = 255;
					data[i + 1] = 255;
					data[i + 2] = 255;
					data[i + 3] = 255; // white barrier, diff 441
				}
			}
		}
		return { data, mask };
	}

	it("should place the boundary sub-pixel using anti-aliased colour values", () => {
		const { data, mask } = buildScene();
		const imageData = { width: W, height: H, data } as ImageData;

		const path = maskToPath(mask, space, defaultFill, {
			imageData,
			seedColor,
			tolerance: 100,
		});

		expect(path).not.toBeNull();
		// Field crossing between x=9 (v=1) and x=10 (v=-0.2) sits at raster
		// ≈9.83; the 1px outward overlap pushes the edge to ≈10.83 → world
		// ≈0.83, past the AA pixel's far edge (world 0.5). Fitted segment
		// endpoints sit near the corners where the offset turns diagonal, so
		// assert just beyond the far edge
		const mx = maxEndX(path?.segments ?? []);
		expect(mx).toBeGreaterThan(0.5);
		expect(mx).toBeLessThan(1.05);
	});

	it("should keep the pixel-midpoint boundary without a sub-pixel source", () => {
		const { mask } = buildScene();

		const path = maskToPath(mask, space, defaultFill);

		expect(path).not.toBeNull();
		// Binary contour caps at the pixel midpoint (world -0.5) plus the 1px
		// overlap — it never advances past the AA column's center
		const mx = maxEndX(path?.segments ?? []);
		expect(mx).toBeLessThan(0.55);
	});
});

describe("maskToPath resolution-scaled simplification", () => {
	it("should preserve detail a hi-res raster captured (wavy edge at scale 8)", () => {
		// 160×160 raster at scale 8 (world 20×20). The right edge waves with
		// amplitude 16px = 2 world — under the former fixed 2.5-world fit
		// tolerance this flattens; at 2.5px it must be followed.
		const W = 160;
		const H = 160;
		const space = createRasterSpace(
			{ centerX: 0, centerY: 0, worldWidth: 20, worldHeight: 20 },
			8,
		);
		const mask = new Uint8Array(W * H);
		for (let y = 8; y < 152; y++) {
			const edge = 80 + 16 * Math.sin((y * 2 * Math.PI) / 32);
			for (let x = 8; x < edge; x++) {
				mask[y * W + x] = 1;
			}
		}

		const path = maskToPath(mask, space, defaultFill);

		expect(path).not.toBeNull();
		// Wave crests reach raster ≈96 → world ≈ (96-80)/8 = 2
		const mx = maxEndX(path?.segments ?? []);
		expect(mx).toBeGreaterThan(1.5);
		expect(mx).toBeLessThan(2.2);
	});
});
