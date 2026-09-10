import type { Filter, Revolve3DParams } from "../../schema";
import { lerp } from "../../utils/math";
import { buildRevolveMesh } from "../geometry/revolveMesh";
import type { Solid3DMeshStrategy } from "./Extrude3D/ExtrudeMeshBaker";
import {
	interpolateMaterial3D,
	Solid3DFilterHandlerBase,
} from "./Solid3DFilterHandlerBase";

/** The revolve3d mesh strategy: sweep the profile outline around a vertical
 *  axis at its left/right edge (± offset) into a solid of revolution. */
export const REVOLVE_SOLID_STRATEGY: Solid3DMeshStrategy = {
	processor: "revolve3d",
	isEnabled: (params) => (params as Revolve3DParams).angleDeg > 0,
	meshParamsHash: (params) => {
		const p = params as Revolve3DParams;
		return `r:${p.angleDeg}:${p.offset}:${p.axis}:${p.cap}`;
	},
	buildMesh: ({ segments, params, tolerance, uvInset }) => {
		const p = params as Revolve3DParams;
		return buildRevolveMesh({
			segments,
			angleDeg: p.angleDeg,
			offset: p.offset,
			axis: p.axis,
			cap: p.cap,
			tolerance,
			uvInset,
			// Store positions center-relative so large world coordinates keep
			// their fp32 depth bits; the baker compensates with T(center).
			rebaseToCenter: true,
		});
	},
};

/**
 * A revolved solid escapes the flat outline sideways by up to the profile
 * width plus twice the offset (the axis-side mirror of the profile), but
 * getExpansionMargin only sees the params — the profile size is unknown here.
 * Cover it with a fixed allowance: an undershoot only clips offscreen
 * accumulators, while the actual bake always self-sizes from exact projected
 * bounds (the same accepted trade-off extrude's depth heuristic documents).
 */
const REVOLVE_PROFILE_ALLOWANCE = 256;

/**
 * FilterHandler for the "revolve3d" appearance ("3D and Materials" Revolve):
 * the shared 3D-solid core (Solid3DFilterHandlerBase) driven by the revolve
 * mesh strategy, plus the revolve-specific params metadata (offset scaling,
 * expansion margin, blend interpolation).
 */
export class Revolve3DFilterHandler extends Solid3DFilterHandlerBase {
	protected readonly strategy: Solid3DMeshStrategy = REVOLVE_SOLID_STRATEGY;

	/** Offset is the only spatial world-unit field — scale by √(sx·sy);
	 *  angleDeg is angular and never scales. */
	public onScaleFilter(filter: Filter, scale: [number, number]): Filter {
		const params = filter.paramData.params as Revolve3DParams;
		const factor = Math.sqrt(Math.abs(scale[0] * scale[1]));
		if (!Number.isFinite(factor) || factor === 1) return filter;
		return {
			...filter,
			paramData: {
				...filter.paramData,
				params: { ...params, offset: params.offset * factor },
			},
		};
	}

	/** Fixed profile allowance + offset mirror, amplified for perspective the
	 *  same way extrude's heuristic is (capped at 4×). */
	public getExpansionMargin(filter: Filter): number {
		const params = filter.paramData.params as Revolve3DParams;
		let margin = 2 * Math.max(params.offset, 0) + REVOLVE_PROFILE_ALLOWANCE;
		if (params.perspective > 0) {
			const fovRad =
				(Math.min(Math.max(params.perspective, 1), 179) * Math.PI) / 180;
			margin *= Math.min(4, 1 / Math.max(Math.cos(fovRad / 2), 0.25));
		}
		return margin + 16;
	}

	/** Lerp every continuous field between a blend's adjacent revolve keys:
	 *  angle/offset/rotation/perspective plus the shared Material3D
	 *  interpolation. Discrete fields (axis side, cap flag, shading mode,
	 *  surface-pattern def) keep the source key's value via the `...a` spread. */
	public onInterpolate(
		a: Revolve3DParams,
		b: Revolve3DParams,
		t: number,
	): unknown {
		return {
			...a,
			angleDeg: lerp(a.angleDeg, b.angleDeg, t),
			offset: lerp(a.offset, b.offset, t),
			rotationDeg: [
				lerp(a.rotationDeg[0], b.rotationDeg[0], t),
				lerp(a.rotationDeg[1], b.rotationDeg[1], t),
				lerp(a.rotationDeg[2], b.rotationDeg[2], t),
			],
			perspective: lerp(a.perspective, b.perspective, t),
			material: interpolateMaterial3D(a.material, b.material, t),
		} satisfies Revolve3DParams;
	}
}
