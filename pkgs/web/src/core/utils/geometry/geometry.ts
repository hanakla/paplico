/**
 * 座標変換ユーティリティ
 *
 * 3つの座標系を扱う：
 * - Screen Space: ブラウザピクセル座標（左上原点、Y軸下向き）
 * - World Space: 無限キャンバス座標（中心原点、Y軸上向き）
 * - NDC: WebGPU正規化デバイス座標（-1~1範囲）
 */

import {
	type BoundingBox,
	type ElementTransform,
	isIdentityTransform,
	type Viewport,
} from "../../schema";
import type { Brand } from "../lang";
import { brandWorldBBox, type LocalBBox, type WorldBBox } from "./bounds";

/**
 * スクリーン座標 → ワールド座標
 */
export function screenToWorld(
	screenX: number,
	screenY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): { x: number; y: number } {
	const relX = screenX - canvasWidth / 2;
	const relY = screenY - canvasHeight / 2;

	// Undo viewport rotation (rotate by -rotation around screen center)
	const cos = Math.cos(-viewport.rotation);
	const sin = Math.sin(-viewport.rotation);
	const unrotX = relX * cos - relY * sin;
	const unrotY = relX * sin + relY * cos;

	const worldX = viewport.x + unrotX / viewport.zoom;
	const worldY = viewport.y - unrotY / viewport.zoom; // Y軸反転

	return { x: worldX, y: worldY };
}

/**
 * ワールド座標 → スクリーン座標
 */
export function worldToScreen(
	worldX: number,
	worldY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): { x: number; y: number } {
	const relX = (worldX - viewport.x) * viewport.zoom;
	const relY = (viewport.y - worldY) * viewport.zoom; // Y軸反転

	// Apply viewport rotation (rotate around screen center)
	const cos = Math.cos(viewport.rotation);
	const sin = Math.sin(viewport.rotation);
	const rotX = relX * cos - relY * sin;
	const rotY = relX * sin + relY * cos;

	const screenX = canvasWidth / 2 + rotX;
	const screenY = canvasHeight / 2 + rotY;

	return { x: screenX, y: screenY };
}

/**
 * ワールド座標 → NDC（Normalized Device Coordinates）
 */
export function worldToNDC(
	worldX: number,
	worldY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): { x: number; y: number } {
	const screen = worldToScreen(
		worldX,
		worldY,
		viewport,
		canvasWidth,
		canvasHeight,
	);

	const ndcX = (screen.x / canvasWidth) * 2 - 1;
	const ndcY = 1 - (screen.y / canvasHeight) * 2; // Y軸反転

	return { x: ndcX, y: ndcY };
}

/**
 * ビューポートの可視範囲を取得（ワールド座標）
 */
export function getVisibleWorldBounds(
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
} {
	const rotation = viewport.rotation ?? 0;

	if (rotation === 0) {
		// Fast path: no rotation
		const halfWidth = canvasWidth / 2 / viewport.zoom;
		const halfHeight = canvasHeight / 2 / viewport.zoom;
		return {
			left: viewport.x - halfWidth,
			right: viewport.x + halfWidth,
			top: viewport.y + halfHeight,
			bottom: viewport.y - halfHeight,
			width: halfWidth * 2,
			height: halfHeight * 2,
		};
	}

	// Rotated viewport: compute world positions of all 4 screen corners
	const corners = [
		screenToWorld(0, 0, viewport, canvasWidth, canvasHeight),
		screenToWorld(canvasWidth, 0, viewport, canvasWidth, canvasHeight),
		screenToWorld(
			canvasWidth,
			canvasHeight,
			viewport,
			canvasWidth,
			canvasHeight,
		),
		screenToWorld(0, canvasHeight, viewport, canvasWidth, canvasHeight),
	];

	let left = corners[0].x;
	let right = corners[0].x;
	let bottom = corners[0].y;
	let top = corners[0].y;
	for (let i = 1; i < 4; i++) {
		left = Math.min(left, corners[i].x);
		right = Math.max(right, corners[i].x);
		bottom = Math.min(bottom, corners[i].y);
		top = Math.max(top, corners[i].y);
	}

	return {
		left,
		right,
		top,
		bottom,
		width: right - left,
		height: top - bottom,
	};
}

/**
 * 点がビューポート内に表示されているか判定
 */
export function isInViewport(
	worldX: number,
	worldY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
	margin = 0, // マージン（ピクセル）
): boolean {
	const bounds = getVisibleWorldBounds(viewport, canvasWidth, canvasHeight);
	const worldMargin = margin / viewport.zoom;

	return (
		worldX >= bounds.left - worldMargin &&
		worldX <= bounds.right + worldMargin &&
		worldY >= bounds.bottom - worldMargin &&
		worldY <= bounds.top + worldMargin
	);
}

/**
 * バウンディングボックスがビューポートに完全に収まっているか
 */
export function boundsFullyInsideViewport(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): boolean {
	const rotation = viewport.rotation ?? 0;
	if (rotation === 0) {
		const halfW = canvasWidth / 2 / viewport.zoom;
		const halfH = canvasHeight / 2 / viewport.zoom;
		return (
			minX >= viewport.x - halfW &&
			maxX <= viewport.x + halfW &&
			minY >= viewport.y - halfH &&
			maxY <= viewport.y + halfH
		);
	}

	const bounds = getVisibleWorldBounds(viewport, canvasWidth, canvasHeight);
	return (
		minX >= bounds.left &&
		maxX <= bounds.right &&
		minY >= bounds.bottom &&
		maxY <= bounds.top
	);
}

/**
 * バウンディングボックスがビューポートと交差しているか
 */
export function boundsIntersectViewport(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): boolean {
	const bounds = getVisibleWorldBounds(viewport, canvasWidth, canvasHeight);

	return !(
		maxX < bounds.left ||
		minX > bounds.right ||
		maxY < bounds.bottom ||
		minY > bounds.top
	);
}

declare const WORLD_POINT_SYMBOL: unique symbol;

/** Branded point type that guarantees world-space coordinates. */
type WorldPoint = {
	readonly x: number;
	readonly y: number;
} & Brand<typeof WORLD_POINT_SYMBOL>;

/** Bezier segment with all coordinates in world space. */
export interface WorldBezierSegment {
	start?: WorldPoint;
	cp1: WorldPoint;
	cp2: WorldPoint;
	end: WorldPoint;
}

/** Cast raw coordinates to WorldPoint. Only call after SRT transform. */
export function toWorld(x: number, y: number): WorldPoint {
	return { x, y } as WorldPoint;
}

declare const WORLD_COORD_SYMBOL: unique symbol;

/** Branded scalar coordinate in world (layer) space. */
export type WorldCoord = number & Brand<typeof WORLD_COORD_SYMBOL>;

declare const LOCAL_COORD_SYMBOL: unique symbol;

/**
 * Branded scalar coordinate in an element-local space. Which element's space
 * it is lives in the doc comment of each API that accepts or returns it.
 */
export type LocalCoord = number & Brand<typeof LOCAL_COORD_SYMBOL>;

/** Brand boundary: only call when the value is known to be world-space. */
export function asWorldCoord(n: number): WorldCoord {
	return n as WorldCoord;
}

/** Brand boundary: only call when the value is known to be element-local. */
export function asLocalCoord(n: number): LocalCoord {
	return n as LocalCoord;
}

/**
 * Inverse-transform a point back into the space local to the given transform.
 * Used for hit testing against raw (untransformed) geometry. The output is by
 * definition local to whatever `t` maps out of, hence the LocalCoord brand.
 */
export function inverseTransform(
	wx: number,
	wy: number,
	t: ElementTransform,
	originX: number,
	originY: number,
): { x: LocalCoord; y: LocalCoord } {
	const inv = invertLinearMatrix(transformLinearMatrix(t));
	if (!inv) return { x: asLocalCoord(wx), y: asLocalCoord(wy) };
	const dx = wx - originX - t.x;
	const dy = wy - originY - t.y;
	return {
		x: asLocalCoord(inv.m00 * dx + inv.m01 * dy + originX),
		y: asLocalCoord(inv.m10 * dx + inv.m11 * dy + originY),
	};
}

/**
 * Compute the transform origin from raw (untransformed) bounding box.
 * Returns the center of the bounds.
 */
export function computeTransformOrigin(localBounds: LocalBBox): {
	x: number;
	y: number;
} {
	return {
		x: (localBounds.minX + localBounds.maxX) / 2,
		y: (localBounds.minY + localBounds.maxY) / 2,
	};
}

/** Row-major 2×2 linear part of an element transform: [[m00 m01],[m10 m11]]. */
export interface LinearMatrix2x2 {
	m00: number;
	m01: number;
	m10: number;
	m11: number;
}

/** Below this |value| a shear/scale factor is treated as absent (fast path). */
const SKEW_EPSILON = 1e-12;

/**
 * Build the 2×2 linear part of an {@link ElementTransform}, applied to a
 * local offset vector (relative to the transform origin) as `M · v`.
 *
 * Order applied to the point (inner → outer): Scale → Shear → Rotate.
 * `M = R(rotation) · Shear(skewX, skewY) · diag(scaleX, scaleY)` with
 * `Shear = [[1, tan(skewX)], [tan(skewY), 1]]`. With no shear this reduces to
 * the historic scale-then-rotate matrix, so skew-free transforms are unchanged.
 */
export function transformLinearMatrix(t: ElementTransform): LinearMatrix2x2 {
	const skewX = t.skewX ?? 0;
	const skewY = t.skewY ?? 0;
	if (t.rotation === 0 && skewX === 0 && skewY === 0) {
		return { m00: t.scaleX, m01: 0, m10: 0, m11: t.scaleY };
	}
	const cos = Math.cos(t.rotation);
	const sin = Math.sin(t.rotation);
	const kx = skewX === 0 ? 0 : Math.tan(skewX);
	const ky = skewY === 0 ? 0 : Math.tan(skewY);
	return {
		m00: t.scaleX * (cos - sin * ky),
		m01: t.scaleY * (cos * kx - sin),
		m10: t.scaleX * (sin + cos * ky),
		m11: t.scaleY * (sin * kx + cos),
	};
}

/** Multiply two 2×2 linear matrices: `a · b`. */
function multiplyLinearMatrix(
	a: LinearMatrix2x2,
	b: LinearMatrix2x2,
): LinearMatrix2x2 {
	return {
		m00: a.m00 * b.m00 + a.m01 * b.m10,
		m01: a.m00 * b.m01 + a.m01 * b.m11,
		m10: a.m10 * b.m00 + a.m11 * b.m10,
		m11: a.m10 * b.m01 + a.m11 * b.m11,
	};
}

/** Invert a 2×2 linear matrix, or `null` when it is singular. */
function invertLinearMatrix(m: LinearMatrix2x2): LinearMatrix2x2 | null {
	const det = m.m00 * m.m11 - m.m01 * m.m10;
	if (Math.abs(det) < SKEW_EPSILON) return null;
	const inv = 1 / det;
	return {
		m00: m.m11 * inv,
		m01: -m.m01 * inv,
		m10: -m.m10 * inv,
		m11: m.m00 * inv,
	};
}

/**
 * Decompose a 2×3 affine (linear part `m` + translation `tx,ty`) back into an
 * {@link ElementTransform} via QR / Gram-Schmidt: `M = R(rotation) · U` where
 * `U` is upper-triangular, canonicalized to a single horizontal shear (`skewX`)
 * with `skewY = 0`. A reflection (det < 0) is carried on `scaleY`. This is the
 * inverse of {@link transformLinearMatrix} for any transform already in this
 * canonical form, so compose/solve round-trips are exact.
 */
export function linearMatrixToTransform(
	m: LinearMatrix2x2,
	tx: number,
	ty: number,
): ElementTransform {
	const scaleX = Math.hypot(m.m00, m.m10);
	if (scaleX < SKEW_EPSILON) {
		// Degenerate first column: no orientation to recover; keep it finite.
		return {
			x: tx,
			y: ty,
			rotation: 0,
			scaleX: 0,
			scaleY: Math.hypot(m.m01, m.m11),
			skewX: 0,
			skewY: 0,
		};
	}
	const cos = m.m00 / scaleX;
	const sin = m.m10 / scaleX;
	// Project column 2 onto the rotated basis (e1 = (cos,sin), e2 = (-sin,cos)).
	const scaleY = -m.m01 * sin + m.m11 * cos; // column2 · e2 (signed → reflection)
	const shear = m.m01 * cos + m.m11 * sin; // column2 · e1 = scaleY · tan(skewX)
	const kx = Math.abs(scaleY) < SKEW_EPSILON ? 0 : shear / scaleY;
	return {
		x: tx,
		y: ty,
		rotation: Math.atan2(sin, cos),
		scaleX,
		scaleY,
		skewX: kx === 0 ? 0 : Math.atan(kx),
		skewY: 0,
	};
}

/**
 * Apply transform to an AABB, producing a new enclosing AABB.
 * Transforms all 4 corners and computes the axis-aligned bounding box.
 */
export function applyTransformToBounds(
	localBounds: BoundingBox,
	t: ElementTransform,
): WorldBBox {
	if (isIdentityTransform(t)) return brandWorldBBox(localBounds);

	const cx = (localBounds.minX + localBounds.maxX) / 2;
	const cy = (localBounds.minY + localBounds.maxY) / 2;
	const m = transformLinearMatrix(t);

	const corners = [
		[localBounds.minX, localBounds.minY],
		[localBounds.maxX, localBounds.minY],
		[localBounds.maxX, localBounds.maxY],
		[localBounds.minX, localBounds.maxY],
	] as const;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const [px, py] of corners) {
		const dx = px - cx;
		const dy = py - cy;
		const rx = m.m00 * dx + m.m01 * dy + cx + t.x;
		const ry = m.m10 * dx + m.m11 * dy + cy + t.y;
		minX = Math.min(minX, rx);
		minY = Math.min(minY, ry);
		maxX = Math.max(maxX, rx);
		maxY = Math.max(maxY, ry);
	}

	// Brand boundary: applying the transform produces world-space bounds
	return brandWorldBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
}

/**
 * Compose two transforms: result = parent ∘ child.
 * Applying the result to a point is equivalent to first applying child, then parent.
 *
 * Math: Scale composes multiplicatively, rotation additively,
 * and child's translation is rotated+scaled by parent before adding parent's translation.
 */
export function composeTransforms(
	parent: ElementTransform,
	child: ElementTransform,
): ElementTransform {
	if (isIdentityTransform(parent)) return child;
	if (isIdentityTransform(child)) return parent;

	// True affine composition: F_parent ∘ F_child.
	// linear = L_parent · L_child, translation = L_parent · t_child + t_parent.
	const P = transformLinearMatrix(parent);
	const linear = multiplyLinearMatrix(P, transformLinearMatrix(child));
	const tx = P.m00 * child.x + P.m01 * child.y + parent.x;
	const ty = P.m10 * child.x + P.m11 * child.y + parent.y;
	return linearMatrixToTransform(linear, tx, ty);
}

/**
 * Invert {@link composeTransforms} in its second argument: returns the child
 * transform `c` for which `composeTransforms(parent, c)` equals `composed`.
 *
 * Use it when an element changes parent but must stay put on screen. Note that
 * `composeTransforms` is not associative — re-parenting by composing the old
 * parent's local transform into the child only lands correctly when the new
 * parent is the identity — so moving between transformed containers has to go
 * through the composed transform and back.
 */
export function solveChildTransform(
	parent: ElementTransform,
	composed: ElementTransform,
): ElementTransform {
	if (isIdentityTransform(parent)) return composed;

	const composedLinear = transformLinearMatrix(composed);
	const Pinv = invertLinearMatrix(transformLinearMatrix(parent));
	if (!Pinv) {
		// A singular (zero-scale) parent collapses its children to a point,
		// leaving nothing to solve for; fall back to the composed transform so
		// the result stays finite.
		return linearMatrixToTransform(
			composedLinear,
			composed.x - parent.x,
			composed.y - parent.y,
		);
	}
	const childLinear = multiplyLinearMatrix(Pinv, composedLinear);
	const ux = composed.x - parent.x;
	const uy = composed.y - parent.y;
	return linearMatrixToTransform(
		childLinear,
		Pinv.m00 * ux + Pinv.m01 * uy,
		Pinv.m10 * ux + Pinv.m11 * uy,
	);
}

/**
 * Compute transform C such that composeTransforms(parent, C) = identity.
 * Used to compensate for a group's world transform when adding child elements,
 * so that the element renders at its original world position despite the
 * ancestor transform chain.
 */
export function computeInverseCompositionTransform(
	parent: ElementTransform,
): ElementTransform {
	if (isIdentityTransform(parent)) return parent;

	const Pinv = invertLinearMatrix(transformLinearMatrix(parent));
	if (!Pinv) {
		return {
			x: 0,
			y: 0,
			rotation: -parent.rotation,
			scaleX: 1,
			scaleY: 1,
			skewX: 0,
			skewY: 0,
		};
	}
	// L_C = L_parent⁻¹, t_C = L_parent⁻¹ · (−t_parent) so compose(parent, C) = identity.
	return linearMatrixToTransform(
		Pinv,
		Pinv.m00 * -parent.x + Pinv.m01 * -parent.y,
		Pinv.m10 * -parent.x + Pinv.m11 * -parent.y,
	);
}

/**
 * Compose a world-space affine (linear `L` + translation `(tx, ty)`, applied as
 * `p' = L · p + t`) onto an element's transform, returning the element's new
 * (parent-local) transform. The element's *visual centre* — its local-bounds
 * centre plus `transform.x/y`, composed through any ancestor transform — is the
 * point moved by the affine, so an anchored scale/shear keeps the fixed side put.
 *
 * This generalises the per-element math in `PaplicoCommands.collectRotateUpdates`
 * from a pure rotation to an arbitrary affine, reusing the same
 * {@link composeTransforms} / {@link solveChildTransform} handling for nested
 * (grouped) elements. `linearMatrixToTransform` canonicalises the result to a
 * single horizontal shear (`skewY = 0`); the underlying matrix is unchanged, so
 * the rendered result is identical even when the input carried a `skewY`.
 */
export function applyWorldAffineToTransform(
	t0: ElementTransform,
	localCenter: { x: number; y: number },
	ancestorT: ElementTransform | null,
	L: LinearMatrix2x2,
	tx: number,
	ty: number,
): ElementTransform {
	// Local-space transform to deform: the element's own transform, or its
	// world-composed transform when nested inside a transformed ancestor.
	const base = ancestorT ? composeTransforms(ancestorT, t0) : t0;

	// Visual centre in world space, then pushed through the world affine.
	const vcx = localCenter.x + base.x;
	const vcy = localCenter.y + base.y;
	const newVcx = L.m00 * vcx + L.m01 * vcy + tx;
	const newVcy = L.m10 * vcx + L.m11 * vcy + ty;

	const newLinear = multiplyLinearMatrix(L, transformLinearMatrix(base));
	const newBase = linearMatrixToTransform(
		newLinear,
		newVcx - localCenter.x,
		newVcy - localCenter.y,
	);

	return ancestorT ? solveChildTransform(ancestorT, newBase) : newBase;
}

/**
 * Forward-transform a local-space point into world space.
 * Applies SRT (scale → rotate → translate) around the given origin.
 */
export function applyTransformToPoint(
	lx: number,
	ly: number,
	t: ElementTransform,
	originX: number,
	originY: number,
): { x: number; y: number } {
	const m = transformLinearMatrix(t);
	const dx = lx - originX;
	const dy = ly - originY;
	return {
		x: m.m00 * dx + m.m01 * dy + originX + t.x,
		y: m.m10 * dx + m.m11 * dy + originY + t.y,
	};
}

/**
 * Inverse of {@link applyTransformToPoint}: pull a world-space point back
 * into the element's pre-transform local space around the same origin.
 * Degenerate scales (0) return the input unchanged.
 */
export function inverseTransformPoint(
	wx: number,
	wy: number,
	t: ElementTransform,
	originX: number,
	originY: number,
): { x: number; y: number } {
	const inv = invertLinearMatrix(transformLinearMatrix(t));
	if (!inv) return { x: wx, y: wy };
	const dx = wx - originX - t.x;
	const dy = wy - originY - t.y;
	return {
		x: inv.m00 * dx + inv.m01 * dy + originX,
		y: inv.m10 * dx + inv.m11 * dy + originY,
	};
}

/**
 * Linear part of {@link inverseTransformPoint} for direction/offset vectors
 * (e.g. anchor-relative Bézier control points): no origin, no translation.
 */
export function inverseTransformVector(
	vx: number,
	vy: number,
	t: ElementTransform,
): { x: number; y: number } {
	const inv = invertLinearMatrix(transformLinearMatrix(t));
	if (!inv) return { x: vx, y: vy };
	return {
		x: inv.m00 * vx + inv.m01 * vy,
		y: inv.m10 * vx + inv.m11 * vy,
	};
}

/** GPU-ready pre-computed transform data (56 bytes / 14 values) */
export interface GPUElementTransform {
	tx: number;
	ty: number;
	originX: number;
	originY: number;
	/** Row-major 2×2 linear part (rotation · shear · scale). */
	m00: number;
	m01: number;
	m10: number;
	m11: number;
	/**
	 * Index into clip mask atlas layer, with {@link MASK_INVERT_BIT} set when
	 * the mask is inverted. 0xFFFFFFFF = no mask.
	 */
	maskIndex: number;
	maskBoundsMinX: number;
	maskBoundsMinY: number;
	maskBoundsMaxX: number;
	maskBoundsMaxY: number;
}

/** Sentinel value for maskIndex: no clip mask applied. */
export const NO_MASK_INDEX = 0xffffffff;

/**
 * Inversion flag packed into the high bit of `maskIndex`.
 *
 * It rides along in the index rather than occupying its own field because the
 * fragment shaders read the mask through an interpolated VertexOutput: a
 * separate field would have to be declared and forwarded in all five shaders
 * that call `applyClipMask`, and any one of them falling out of sync would
 * silently mis-render. The NO_MASK_INDEX sentinel also has this bit set, but
 * `applyClipMask` tests for the sentinel first, so the two never collide.
 */
export const MASK_INVERT_BIT = 0x8000_0000;

/** Identity GPU transform (no-op in shader) */
export const IDENTITY_GPU_TRANSFORM: GPUElementTransform = {
	tx: 0,
	ty: 0,
	originX: 0,
	originY: 0,
	m00: 1,
	m01: 0,
	m10: 0,
	m11: 1,
	maskIndex: NO_MASK_INDEX,
	maskBoundsMinX: 0,
	maskBoundsMinY: 0,
	maskBoundsMaxX: 0,
	maskBoundsMaxY: 0,
};

/**
 * Number of 4-byte values per GPU transform entry.
 * Layout: 8 f32 + 2 u32 + 4 f32 = 14 values (56 bytes).
 */
export const GPU_TRANSFORM_VALUES = 14;

/** @deprecated Use GPU_TRANSFORM_VALUES */
export const GPU_TRANSFORM_FLOATS = GPU_TRANSFORM_VALUES;

/**
 * Write GPU transform data into an ArrayBuffer at the given value offset.
 * Each transform occupies 14 × 4-byte values (56 bytes).
 * Requires both Float32Array and Uint32Array views over the same buffer.
 */
export function writeGPUTransform(
	f32: Float32Array,
	offset: number,
	gt: GPUElementTransform,
	u32?: Uint32Array,
): void {
	f32[offset] = gt.tx;
	f32[offset + 1] = gt.ty;
	f32[offset + 2] = gt.originX;
	f32[offset + 3] = gt.originY;
	f32[offset + 4] = gt.m00;
	f32[offset + 5] = gt.m01;
	f32[offset + 6] = gt.m10;
	f32[offset + 7] = gt.m11;
	// maskIndex and _pad1 are u32 values — write via Uint32Array view
	const u = u32 ?? new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
	u[offset + 8] = gt.maskIndex;
	u[offset + 9] = 0; // _pad1
	f32[offset + 10] = gt.maskBoundsMinX;
	f32[offset + 11] = gt.maskBoundsMinY;
	f32[offset + 12] = gt.maskBoundsMaxX;
	f32[offset + 13] = gt.maskBoundsMaxY;
}

/**
 * Convert a local cursor position to world coordinates, applying element
 * transform around the given origin. Returns identity-path result when
 * the transform is identity.
 */
export function cursorLocalToWorld(
	localPos: { x: number; y: number; height: number },
	elementX: number,
	elementY: number,
	t: ElementTransform,
	origin: { x: number; y: number },
	writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr",
): { x: number; y: number; height: number } {
	const ex = localPos.x + elementX;
	const ey = localPos.y + elementY;

	if (isIdentityTransform(t)) {
		return { x: ex, y: ey, height: localPos.height };
	}

	const world = applyTransformToPoint(ex, ey, t, origin.x, origin.y);
	const isVertical =
		writingMode === "vertical-rl" || writingMode === "vertical-lr";
	return {
		x: world.x,
		y: world.y,
		height: localPos.height * Math.abs(isVertical ? t.scaleX : t.scaleY),
	};
}
