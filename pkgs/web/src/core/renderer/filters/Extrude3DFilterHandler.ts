import type { Extrude3DParams, Filter } from "../../schema";
import { lerp } from "../../utils/geometry/bezierBool";
import {
	EXTRUDE_SOLID_STRATEGY,
	type Solid3DMeshStrategy,
} from "./Extrude3D/ExtrudeMeshBaker";
import {
	interpolateMaterial3D,
	Solid3DFilterHandlerBase,
} from "./Solid3DFilterHandlerBase";

/**
 * FilterHandler for the "extrude3d" appearance: the shared 3D-solid core
 * (Solid3DFilterHandlerBase) driven by the extrude mesh strategy, plus the
 * extrude-specific params metadata (depth/bevel scaling, expansion margin,
 * blend interpolation).
 */
export class Extrude3DFilterHandler extends Solid3DFilterHandlerBase {
	protected readonly strategy: Solid3DMeshStrategy = EXTRUDE_SOLID_STRATEGY;

	/** Depth is a spatial world-unit field — scale uniformly by √(sx·sy),
	 *  and the bevel radius follows it. */
	public onScaleFilter(filter: Filter, scale: [number, number]): Filter {
		const params = filter.paramData.params as Extrude3DParams;
		const factor = Math.sqrt(Math.abs(scale[0] * scale[1]));
		if (!Number.isFinite(factor) || factor === 1) return filter;
		return {
			...filter,
			paramData: {
				...filter.paramData,
				params: {
					...params,
					depth: params.depth * factor,
					...(params.bevel
						? { bevel: { ...params.bevel, size: params.bevel.size * factor } }
						: {}),
				},
			},
		};
	}

	/**
	 * Upper bound on how far the extrusion can escape the 2D outline. With
	 * only X/Y-axis rotations (no roll) the rotated depth vector reaches at
	 * most `depth` sideways at any angle, so 1.5× plus a fixed pad stays an
	 * upper bound for free ±180° rotation under orthographic projection.
	 * Perspective can magnify geometry rotated in front of the projection
	 * plane by 1/(1 - z'/f); z' also depends on the outline size (unknown
	 * here), so the amplification is capped at 4× to keep the heuristic
	 * finite — extreme cases only clip offscreen accumulators, while the
	 * actual bake always uses exact projected bounds.
	 */
	public getExpansionMargin(filter: Filter): number {
		const params = filter.paramData.params as Extrude3DParams;
		const depth = Math.abs(params.depth);
		let margin = depth * 1.5;
		if (params.perspective > 0) {
			const fovRad =
				(Math.min(Math.max(params.perspective, 1), 179) * Math.PI) / 180;
			margin *= Math.min(4, 1 / Math.max(Math.cos(fovRad / 2), 0.25));
		}
		return margin + 16;
	}

	/** Lerp every continuous field between a blend's adjacent extrude keys:
	 *  depth/rotation/perspective/bevel size, plus the material's lighting
	 *  (direction + light/shadow/fresnel colors) and PBR/glass scalars (glass
	 *  coverage, refraction/thickness/aberration/blur, roughness/metalness/…) —
	 *  so a glass extrude blends into another glass extrude instead of the
	 *  intermediates snapping to the source key's material. Discrete material
	 *  fields (shading mode, fresnel toggle, surface-pattern def) can't
	 *  interpolate and keep the source key's value. */
	public onInterpolate(
		a: Extrude3DParams,
		b: Extrude3DParams,
		t: number,
	): unknown {
		return {
			...a,
			depth: lerp(a.depth, b.depth, t),
			rotationDeg: [
				lerp(a.rotationDeg[0], b.rotationDeg[0], t),
				lerp(a.rotationDeg[1], b.rotationDeg[1], t),
				lerp(a.rotationDeg[2], b.rotationDeg[2], t),
			],
			perspective: lerp(a.perspective, b.perspective, t),
			material: interpolateMaterial3D(a.material, b.material, t),
			...(a.bevel &&
				b.bevel && {
					bevel: { ...a.bevel, size: lerp(a.bevel.size, b.bevel.size, t) },
				}),
		} satisfies Extrude3DParams;
	}
}
