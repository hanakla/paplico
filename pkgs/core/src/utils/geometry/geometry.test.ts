import { describe, expect, it } from "vitest";
import type { ElementTransform, Viewport } from "../../schema";
import { degToRad } from "../math";
import {
	applyTransformToPoint,
	applyWorldAffineToTransform,
	boundsIntersectViewport,
	composeTransforms,
	getVisibleWorldBounds,
	inverseTransformPoint,
	inverseTransformVector,
	isInViewport,
	linearMatrixToTransform,
	mirrorTransform,
	screenToWorld,
	solveChildTransform,
	transformLinearMatrix,
	worldToNDC,
	worldToScreen,
} from "./geometry";

describe("coordinates", () => {
	const viewport: Viewport = {
		x: 0,
		y: 0,
		zoom: 1,
		rotation: 0,
	};

	const canvasWidth = 800;
	const canvasHeight = 600;

	describe("screenToWorld", () => {
		it("should convert center screen position to world origin", () => {
			const result = screenToWorld(
				400,
				300,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
		});

		it("should convert top-left screen position correctly", () => {
			const result = screenToWorld(0, 0, viewport, canvasWidth, canvasHeight);
			expect(result.x).toBeCloseTo(-400);
			expect(result.y).toBeCloseTo(300);
		});

		it("should account for viewport zoom", () => {
			const zoomedViewport: Viewport = { x: 0, y: 0, zoom: 2, rotation: 0 };
			const result = screenToWorld(
				600,
				300,
				zoomedViewport,
				canvasWidth,
				canvasHeight,
			);
			expect(result.x).toBeCloseTo(100);
			expect(result.y).toBeCloseTo(0);
		});

		it("should account for viewport offset", () => {
			const offsetViewport: Viewport = { x: 100, y: 50, zoom: 1, rotation: 0 };
			const result = screenToWorld(
				400,
				300,
				offsetViewport,
				canvasWidth,
				canvasHeight,
			);
			expect(result.x).toBeCloseTo(100);
			expect(result.y).toBeCloseTo(50);
		});
	});

	describe("worldToScreen", () => {
		it("should convert world origin to center screen position", () => {
			const result = worldToScreen(0, 0, viewport, canvasWidth, canvasHeight);
			expect(result.x).toBeCloseTo(400);
			expect(result.y).toBeCloseTo(300);
		});

		it("should stay invertible for rotated viewports", () => {
			const rotatedViewport: Viewport = {
				x: 15,
				y: -25,
				zoom: 1.4,
				rotation: degToRad(37),
			};
			const screen = worldToScreen(
				120,
				-40,
				rotatedViewport,
				canvasWidth,
				canvasHeight,
			);
			const world = screenToWorld(
				screen.x,
				screen.y,
				rotatedViewport,
				canvasWidth,
				canvasHeight,
			);
			expect(world.x).toBeCloseTo(120);
			expect(world.y).toBeCloseTo(-40);
		});

		it("should be inverse of screenToWorld", () => {
			const worldPos = screenToWorld(
				600,
				450,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			const screenPos = worldToScreen(
				worldPos.x,
				worldPos.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			expect(screenPos.x).toBeCloseTo(600);
			expect(screenPos.y).toBeCloseTo(450);
		});

		it("should account for viewport zoom", () => {
			const zoomedViewport: Viewport = { x: 0, y: 0, zoom: 2, rotation: 0 };
			const result = worldToScreen(
				100,
				0,
				zoomedViewport,
				canvasWidth,
				canvasHeight,
			);
			expect(result.x).toBeCloseTo(600);
			expect(result.y).toBeCloseTo(300);
		});
	});

	describe("worldToNDC", () => {
		it("should convert world origin to center NDC", () => {
			const result = worldToNDC(0, 0, viewport, canvasWidth, canvasHeight);
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
		});

		it("should convert to NDC range -1 to 1", () => {
			const result = worldToNDC(400, 300, viewport, canvasWidth, canvasHeight);
			expect(result.x).toBeCloseTo(1);
			expect(result.y).toBeCloseTo(1);
		});
	});

	describe("getVisibleWorldBounds", () => {
		it("should return correct bounds for default viewport", () => {
			const bounds = getVisibleWorldBounds(viewport, canvasWidth, canvasHeight);
			expect(bounds.left).toBeCloseTo(-400);
			expect(bounds.right).toBeCloseTo(400);
			expect(bounds.top).toBeCloseTo(300);
			expect(bounds.bottom).toBeCloseTo(-300);
			expect(bounds.width).toBeCloseTo(800);
			expect(bounds.height).toBeCloseTo(600);
		});

		it("should scale bounds with zoom", () => {
			const zoomedViewport: Viewport = { x: 0, y: 0, zoom: 2, rotation: 0 };
			const bounds = getVisibleWorldBounds(
				zoomedViewport,
				canvasWidth,
				canvasHeight,
			);
			expect(bounds.width).toBeCloseTo(400);
			expect(bounds.height).toBeCloseTo(300);
		});

		it("should offset bounds with viewport position", () => {
			const offsetViewport: Viewport = { x: 100, y: 50, zoom: 1, rotation: 0 };
			const bounds = getVisibleWorldBounds(
				offsetViewport,
				canvasWidth,
				canvasHeight,
			);
			expect(bounds.left).toBeCloseTo(-300);
			expect(bounds.right).toBeCloseTo(500);
			expect(bounds.top).toBeCloseTo(350);
			expect(bounds.bottom).toBeCloseTo(-250);
		});

		it("should produce a prebuf bounds quad that covers the rotated screen", () => {
			const rotatedViewport: Viewport = {
				x: 10,
				y: -5,
				zoom: 1.2,
				rotation: degToRad(37),
			};
			const prebufBounds = getVisibleWorldBounds(
				rotatedViewport,
				canvasWidth,
				canvasHeight,
			);
			const quad = [
				worldToScreen(
					prebufBounds.left,
					prebufBounds.bottom,
					rotatedViewport,
					canvasWidth,
					canvasHeight,
				),
				worldToScreen(
					prebufBounds.right,
					prebufBounds.bottom,
					rotatedViewport,
					canvasWidth,
					canvasHeight,
				),
				worldToScreen(
					prebufBounds.right,
					prebufBounds.top,
					rotatedViewport,
					canvasWidth,
					canvasHeight,
				),
				worldToScreen(
					prebufBounds.left,
					prebufBounds.top,
					rotatedViewport,
					canvasWidth,
					canvasHeight,
				),
			];
			const containsPoint = (x: number, y: number) => {
				let sign = 0;
				for (let i = 0; i < quad.length; i++) {
					const a = quad[i];
					const b = quad[(i + 1) % quad.length];
					const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
					if (Math.abs(cross) < 1e-6) continue;
					const currentSign = Math.sign(cross);
					if (sign === 0) {
						sign = currentSign;
						continue;
					}
					if (sign !== currentSign) return false;
				}
				return true;
			};

			expect(containsPoint(0, 0)).toBe(true);
			expect(containsPoint(canvasWidth, 0)).toBe(true);
			expect(containsPoint(canvasWidth, canvasHeight)).toBe(true);
			expect(containsPoint(0, canvasHeight)).toBe(true);
		});

		it("should require a no-rotation viewport for CPU-side prebuf bounds", () => {
			const rotatedViewport: Viewport = {
				x: 123.4,
				y: -56.7,
				zoom: 1.5,
				rotation: degToRad(37),
			};
			const rotatedScreenBounds = getVisibleWorldBounds(
				rotatedViewport,
				canvasWidth,
				canvasHeight,
			);
			const prebufWidth = Math.ceil(
				rotatedScreenBounds.width * rotatedViewport.zoom,
			);
			const prebufHeight = Math.ceil(
				rotatedScreenBounds.height * rotatedViewport.zoom,
			);
			const wrongCpuBounds = getVisibleWorldBounds(
				rotatedViewport,
				prebufWidth,
				prebufHeight,
			);
			const correctCpuBounds = getVisibleWorldBounds(
				{ ...rotatedViewport, rotation: 0 },
				prebufWidth,
				prebufHeight,
			);

			expect(wrongCpuBounds.width - correctCpuBounds.width).toBeGreaterThan(
				200,
			);
			expect(wrongCpuBounds.height - correctCpuBounds.height).toBeGreaterThan(
				200,
			);
			expect(correctCpuBounds.width).toBeCloseTo(
				prebufWidth / rotatedViewport.zoom,
			);
			expect(correctCpuBounds.height).toBeCloseTo(
				prebufHeight / rotatedViewport.zoom,
			);
		});
	});

	describe("isInViewport", () => {
		it("should return true for point at world origin", () => {
			expect(isInViewport(0, 0, viewport, canvasWidth, canvasHeight)).toBe(
				true,
			);
		});

		it("should return true for point within bounds", () => {
			expect(isInViewport(200, 100, viewport, canvasWidth, canvasHeight)).toBe(
				true,
			);
		});

		it("should return false for point outside bounds", () => {
			expect(isInViewport(500, 0, viewport, canvasWidth, canvasHeight)).toBe(
				false,
			);
			expect(isInViewport(0, 400, viewport, canvasWidth, canvasHeight)).toBe(
				false,
			);
		});

		it("should respect margin parameter", () => {
			expect(isInViewport(410, 0, viewport, canvasWidth, canvasHeight, 0)).toBe(
				false,
			);
			expect(
				isInViewport(410, 0, viewport, canvasWidth, canvasHeight, 20),
			).toBe(true);
		});
	});

	describe("boundsIntersectViewport", () => {
		it("should return true for bounds completely within viewport", () => {
			expect(
				boundsIntersectViewport(
					-100,
					-100,
					100,
					100,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(true);
		});

		it("should return true for bounds partially overlapping viewport", () => {
			expect(
				boundsIntersectViewport(
					300,
					-100,
					500,
					100,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(true);
		});

		it("should return false for bounds completely outside viewport", () => {
			expect(
				boundsIntersectViewport(
					500,
					500,
					600,
					600,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(false);
		});

		it("should return true for bounds containing entire viewport", () => {
			expect(
				boundsIntersectViewport(
					-1000,
					-1000,
					1000,
					1000,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(true);
		});
	});
});

describe("inverseTransformPoint", () => {
	const t = { x: 12, y: -8, rotation: Math.PI / 5, scaleX: 2, scaleY: 0.5 };
	const origin = { x: 40, y: 25 };

	it("should round-trip with applyTransformToPoint", () => {
		const local = { x: 17, y: -3 };
		const world = applyTransformToPoint(
			local.x,
			local.y,
			t,
			origin.x,
			origin.y,
		);
		const back = inverseTransformPoint(world.x, world.y, t, origin.x, origin.y);
		expect(back.x).toBeCloseTo(local.x);
		expect(back.y).toBeCloseTo(local.y);
	});

	it("should round-trip relative vectors through the linear part", () => {
		const v = { x: 9, y: 4 };
		// Forward linear part: rotate + scale without origin/translation
		const cos = Math.cos(t.rotation);
		const sin = Math.sin(t.rotation);
		const fwd = {
			x: v.x * t.scaleX * cos - v.y * t.scaleY * sin,
			y: v.x * t.scaleX * sin + v.y * t.scaleY * cos,
		};
		const back = inverseTransformVector(fwd.x, fwd.y, t);
		expect(back.x).toBeCloseTo(v.x);
		expect(back.y).toBeCloseTo(v.y);
	});

	it("should return the input unchanged for degenerate scales", () => {
		const zero = { ...t, scaleX: 0 };
		expect(inverseTransformPoint(3, 4, zero, 0, 0)).toEqual({ x: 3, y: 4 });
		expect(inverseTransformVector(3, 4, zero)).toEqual({ x: 3, y: 4 });
	});
});

describe("mirrorTransform", () => {
	const origin = { x: 30, y: 20 };

	it("should mirror points around the transform origin on the X axis", () => {
		const t = { x: 0, y: 0, rotation: Math.PI / 6, scaleX: 2, scaleY: 0.5 };
		const local = { x: 44, y: 9 };
		const before = applyTransformToPoint(
			local.x,
			local.y,
			t,
			origin.x,
			origin.y,
		);
		const after = applyTransformToPoint(
			local.x,
			local.y,
			mirrorTransform(t, true, false),
			origin.x,
			origin.y,
		);

		expect(after.x).toBeCloseTo(2 * origin.x - before.x);
		expect(after.y).toBeCloseTo(before.y);
	});

	it("should return the same transform when no axis is mirrored", () => {
		const t = { x: 3, y: 4, rotation: 1, scaleX: 2, scaleY: 2 };
		expect(mirrorTransform(t, false, false)).toBe(t);
	});
});

describe("solveChildTransform", () => {
	const cases: Array<[string, ElementTransform]> = [
		["identity", { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }],
		["translated", { x: 12, y: -7, rotation: 0, scaleX: 1, scaleY: 1 }],
		[
			"rotated + uniformly scaled",
			{ x: 10, y: -5, rotation: 0.7, scaleX: 2, scaleY: 2 },
		],
		[
			"rotated + non-uniformly scaled",
			{ x: -3, y: 9, rotation: -1.9, scaleX: 0.3, scaleY: 4 },
		],
	];

	for (const [label, parent] of cases) {
		it(`should invert composition under a ${label} parent`, () => {
			const child: ElementTransform = {
				x: 100,
				y: -40,
				rotation: 2.2,
				scaleX: 5,
				scaleY: 0.1,
			};
			const composed = composeTransforms(parent, child);

			const solved = solveChildTransform(parent, composed);

			expect(solved.x).toBeCloseTo(child.x, 9);
			expect(solved.y).toBeCloseTo(child.y, 9);
			expect(solved.rotation).toBeCloseTo(child.rotation, 9);
			expect(solved.scaleX).toBeCloseTo(child.scaleX, 9);
			expect(solved.scaleY).toBeCloseTo(child.scaleY, 9);
		});
	}

	it("should re-parent an element without moving it", () => {
		// The shape the mask release relies on: an element under `owner`, which
		// itself sits under `container`, moved up to be a sibling of `owner`.
		const container: ElementTransform = {
			x: 10,
			y: -5,
			rotation: 0.7,
			scaleX: 2,
			scaleY: 0.5,
		};
		const owner: ElementTransform = {
			x: 30,
			y: 12,
			rotation: 0.4,
			scaleX: 1.5,
			scaleY: 3,
		};
		const nested: ElementTransform = {
			x: -8,
			y: 20,
			rotation: -0.2,
			scaleX: 0.8,
			scaleY: 1.2,
		};
		const before = composeTransforms(
			composeTransforms(container, owner),
			nested,
		);

		const promoted = solveChildTransform(container, before);
		const after = composeTransforms(container, promoted);

		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	it("should give an element centred on its parent the parent's own placement", () => {
		const parent: ElementTransform = {
			x: 40,
			y: 25,
			rotation: 0.3,
			scaleX: 2,
			scaleY: 2,
		};
		const identity: ElementTransform = {
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		};

		const promoted = solveChildTransform(
			identity,
			composeTransforms(parent, identity),
		);

		expect(promoted).toEqual(parent);
	});
});

describe("skew (shear) transforms", () => {
	const a: ElementTransform = {
		x: 5,
		y: -3,
		rotation: 0.4,
		scaleX: 1.5,
		scaleY: 0.8,
		skewX: degToRad(20),
		skewY: degToRad(-10),
	};
	const b: ElementTransform = {
		x: -2,
		y: 7,
		rotation: -0.6,
		scaleX: 0.9,
		scaleY: 1.3,
		skewX: degToRad(-15),
		skewY: degToRad(25),
	};

	it("should round-trip applyTransformToPoint through inverseTransformPoint", () => {
		const world = applyTransformToPoint(9, 4, a, 2, 1);
		const back = inverseTransformPoint(world.x, world.y, a, 2, 1);
		expect(back.x).toBeCloseTo(9, 9);
		expect(back.y).toBeCloseTo(4, 9);
	});

	it("should reconstruct a canonical transform's matrix via QR round-trip", () => {
		const canonical: ElementTransform = { ...a, skewY: 0 };
		const m = transformLinearMatrix(canonical);
		const decoded = linearMatrixToTransform(m, canonical.x, canonical.y);
		expect(decoded.rotation).toBeCloseTo(canonical.rotation, 9);
		expect(decoded.scaleX).toBeCloseTo(canonical.scaleX, 9);
		expect(decoded.scaleY).toBeCloseTo(canonical.scaleY, 9);
		expect(decoded.skewX).toBeCloseTo(canonical.skewX ?? 0, 9);
		expect(decoded.skewY).toBe(0);
	});

	it("should make composeTransforms equal function composition (group inheritance)", () => {
		const p = { x: 6, y: -4 };
		const viaB = applyTransformToPoint(p.x, p.y, b, 0, 0);
		const viaAB = applyTransformToPoint(viaB.x, viaB.y, a, 0, 0);
		const composed = composeTransforms(a, b);
		const direct = applyTransformToPoint(p.x, p.y, composed, 0, 0);
		expect(direct.x).toBeCloseTo(viaAB.x, 6);
		expect(direct.y).toBeCloseTo(viaAB.y, 6);
	});

	it("should keep composition associative under skew", () => {
		const c: ElementTransform = {
			x: 1,
			y: 1,
			rotation: 0.2,
			scaleX: 1.1,
			scaleY: 1.1,
			skewX: 0,
			skewY: degToRad(12),
		};
		const left = composeTransforms(composeTransforms(a, b), c);
		const right = composeTransforms(a, composeTransforms(b, c));
		const p = { x: 6, y: -4 };
		const lp = applyTransformToPoint(p.x, p.y, left, 0, 0);
		const rp = applyTransformToPoint(p.x, p.y, right, 0, 0);
		expect(lp.x).toBeCloseTo(rp.x, 6);
		expect(lp.y).toBeCloseTo(rp.y, 6);
	});

	it("should let solveChildTransform invert composeTransforms under skew", () => {
		const solved = solveChildTransform(a, composeTransforms(a, b));
		// b has skewY≠0, so QR re-canonicalizes to skewY=0; compare by the point
		// mapping (identical matrix), not by field equality.
		const p = { x: 3, y: 8 };
		const viaSolved = applyTransformToPoint(p.x, p.y, solved, 0, 0);
		const viaB = applyTransformToPoint(p.x, p.y, b, 0, 0);
		expect(viaSolved.x).toBeCloseTo(viaB.x, 6);
		expect(viaSolved.y).toBeCloseTo(viaB.y, 6);
	});

	it("should shear a child's geometry through a skewed parent group", () => {
		const group: ElementTransform = {
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			skewX: degToRad(30),
			skewY: 0,
		};
		const child: ElementTransform = {
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		};
		const composed = composeTransforms(group, child);
		// A local point at (0, 10): pure skewX shifts x by tan(30°)·10, y unchanged.
		const world = applyTransformToPoint(0, 10, composed, 0, 0);
		expect(world.x).toBeCloseTo(Math.tan(degToRad(30)) * 10, 6);
		expect(world.y).toBeCloseTo(10, 6);
	});
});

describe("applyWorldAffineToTransform", () => {
	// The element renders local point `p` to world through its transform about
	// its local-bounds centre as origin: w(p) = M·(p − c) + c + t.
	const localCenter = { x: 40, y: 25 };
	const t0: ElementTransform = {
		x: 12,
		y: -7,
		rotation: degToRad(18),
		scaleX: 1.3,
		scaleY: 0.7,
		skewX: degToRad(10),
		skewY: 0,
	};
	// A non-trivial world affine (scale + shear + rotation) built from a transform.
	const L = transformLinearMatrix({
		x: 0,
		y: 0,
		rotation: degToRad(-12),
		scaleX: 1.6,
		scaleY: 0.5,
		skewX: degToRad(22),
		skewY: 0,
	});
	const tx = 15;
	const ty = -9;

	const probes = [
		{ x: 40, y: 25 },
		{ x: 0, y: 0 },
		{ x: 90, y: 10 },
		{ x: -30, y: 60 },
	];

	it("should map the whole geometry by the world affine (no ancestor)", () => {
		const newT = applyWorldAffineToTransform(t0, localCenter, null, L, tx, ty);
		for (const p of probes) {
			const oldW = applyTransformToPoint(
				p.x,
				p.y,
				t0,
				localCenter.x,
				localCenter.y,
			);
			// Desired world point after applying p' = L·p + t to the old world point.
			const desiredX = L.m00 * oldW.x + L.m01 * oldW.y + tx;
			const desiredY = L.m10 * oldW.x + L.m11 * oldW.y + ty;
			const newW = applyTransformToPoint(
				p.x,
				p.y,
				newT,
				localCenter.x,
				localCenter.y,
			);
			expect(newW.x).toBeCloseTo(desiredX, 6);
			expect(newW.y).toBeCloseTo(desiredY, 6);
		}
	});

	it("should be a no-op for the identity affine", () => {
		const identity = { m00: 1, m01: 0, m10: 0, m11: 1 };
		const newT = applyWorldAffineToTransform(
			t0,
			localCenter,
			null,
			identity,
			0,
			0,
		);
		for (const p of probes) {
			const oldW = applyTransformToPoint(
				p.x,
				p.y,
				t0,
				localCenter.x,
				localCenter.y,
			);
			const newW = applyTransformToPoint(
				p.x,
				p.y,
				newT,
				localCenter.x,
				localCenter.y,
			);
			expect(newW.x).toBeCloseTo(oldW.x, 6);
			expect(newW.y).toBeCloseTo(oldW.y, 6);
		}
	});

	it("should map the whole geometry by the world affine through an ancestor group", () => {
		const ancestorT: ElementTransform = {
			x: -8,
			y: 14,
			rotation: degToRad(25),
			scaleX: 0.9,
			scaleY: 1.2,
			skewX: 0,
			skewY: degToRad(8),
		};
		const newChildT = applyWorldAffineToTransform(
			t0,
			localCenter,
			ancestorT,
			L,
			tx,
			ty,
		);
		for (const p of probes) {
			const oldComposed = composeTransforms(ancestorT, t0);
			const oldW = applyTransformToPoint(
				p.x,
				p.y,
				oldComposed,
				localCenter.x,
				localCenter.y,
			);
			const desiredX = L.m00 * oldW.x + L.m01 * oldW.y + tx;
			const desiredY = L.m10 * oldW.x + L.m11 * oldW.y + ty;
			const newComposed = composeTransforms(ancestorT, newChildT);
			const newW = applyTransformToPoint(
				p.x,
				p.y,
				newComposed,
				localCenter.x,
				localCenter.y,
			);
			expect(newW.x).toBeCloseTo(desiredX, 5);
			expect(newW.y).toBeCloseTo(desiredY, 5);
		}
	});
});
