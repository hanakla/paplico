/**
 * Builds the BG2 paint bind group for textured fills: gradient uniforms,
 * colour stops, free/pattern texture and mesh buffers. Fingerprint caching
 * skips the buffer writes when nothing changed.
 */

import { colorToRawRGBA, type TexturedFill } from "../../../schema";
import type { GradientState } from "../CanvasLayerTypes";
import { type GradientCache, hashGradientDraw } from "../caches/GradientCache";

interface GradientRendererDeps {
	device: GPUDevice;
	gradient: GradientState;
	gradientCache: GradientCache;
}

/** Everything a gradient draw needs beyond its geometry and paint. */
interface GradientDrawOptions {
	/** Enables caching together with `geometryHash`; omit for uncacheable draws. */
	cacheKey?: string;
	geometryHash?: number;
	transformIndex?: number;
	/**
	 * Resolved pattern source texture for `PatternFill`. Required when
	 * `fill.type === "pattern"` — pattern sampling falls back to the
	 * placeholder texture when null, which produces an empty sample.
	 */
	patternTexture?: GPUTexture | null;
	/**
	 * World-space tile size for `PatternFill` (the def's `tile.width` /
	 * `tile.height`). The shader divides post-scale world coords by this
	 * value to derive normalized tile UV with `fract()`.
	 */
	patternTileWorldSize?: { width: number; height: number };
	/**
	 * StrokeGradientMode for geometric strokes (0 = within / 1 = along /
	 * 2 = across). along/across sample the stops from the per-pixel
	 * (t, u) params instead of the bounds-space coordinates.
	 */
	strokeGradientMode?: number;
}

export class GradientRenderer {
	private readonly deps: GradientRendererDeps;

	public constructor(deps: GradientRendererDeps) {
		this.deps = deps;
	}

	/**
	 * The paint bind group for a textured fill over `boundsMin..boundsMax`
	 * (local space). When cacheKey and geometryHash are provided, dedicated
	 * GPU resources are cached and reused while the fingerprint matches. Free,
	 * mesh and pattern fills are not cached.
	 */
	public acquirePaintBindGroup(
		fill: TexturedFill,
		boundsMin: [number, number],
		boundsMax: [number, number],
		options: GradientDrawOptions = {},
	): GPUBindGroup {
		const {
			cacheKey,
			geometryHash,
			transformIndex,
			patternTexture,
			patternTileWorldSize,
			strokeGradientMode,
		} = options;

		const cacheable =
			cacheKey != null &&
			geometryHash != null &&
			fill.type !== "free" &&
			fill.type !== "mesh" &&
			fill.type !== "pattern";
		const modeValue = strokeGradientMode ?? 0;
		// Computed once and reused by both the lookup and the store below —
		// when the two were separate expressions, an input added to one of them
		// silently skipped the other.
		const fingerprint = cacheable
			? hashGradientDraw(
					fill,
					boundsMin,
					boundsMax,
					(geometryHash * 31 + modeValue) | 0,
					transformIndex,
				)
			: 0;

		if (cacheable) {
			const cached = this.deps.gradientCache.get(cacheKey);
			if (cached && cached.fingerprint === fingerprint) return cached.bindGroup;
		}

		const uv = this.deps.gradient.uniformView;
		const isPattern = fill.type === "pattern";
		// Pattern tile world size is passed in by the caller (CanvasLayer),
		// which reads it from the def entry. patternScale stretches on top.
		uv.set({
			gradientType: GRADIENT_TYPE_INDEX[fill.type] ?? 0,
			stopCount:
				fill.type === "linear" || fill.type === "radial"
					? fill.stops.length
					: 0,
			meshFaceCount: fill.type === "mesh" ? fill.faces.length : 0,
			strokeGradientMode: modeValue,
			linearStart: fill.type === "linear" ? [fill.x1, fill.y1] : [0, 0],
			linearEnd: fill.type === "linear" ? [fill.x2, fill.y2] : [0, 0],
			radialCenter: fill.type === "radial" ? [fill.cx, fill.cy] : [0, 0],
			radialRadiusX: fill.type === "radial" ? fill.radiusX : 0,
			radialRadiusY: fill.type === "radial" ? fill.radiusY : 0,
			radialRotation: fill.type === "radial" ? fill.rotation : 0,
			boundsMin,
			boundsMax,
			patternOffset: isPattern ? [fill.offsetX, fill.offsetY] : [0, 0],
			patternScale: isPattern ? [fill.scaleX, fill.scaleY] : [1, 1],
			patternRotation: isPattern ? fill.rotation : 0,
			patternTileWidth:
				isPattern && patternTileWorldSize
					? Math.max(1e-6, patternTileWorldSize.width)
					: 1,
			patternTileHeight:
				isPattern && patternTileWorldSize
					? Math.max(1e-6, patternTileWorldSize.height)
					: 1,
			_pad1: 0,
			patternAnchor: isPattern ? [boundsMin[0], boundsMax[1]] : [0, 0],
		});

		const sv = this.deps.gradient.stopsView;
		new Uint8Array(sv.arrayBuffer).fill(0);

		if (fill.type === "linear" || fill.type === "radial") {
			const stopsData: Array<{
				offset: number;
				r: number;
				g: number;
				b: number;
				a: number;
				midpoint: number;
			}> = [];
			for (let i = 0; i < fill.stops.length && i < 16; i++) {
				const s = fill.stops[i];
				const c = colorToRawRGBA(s.color);
				stopsData.push({
					offset: s.offset,
					r: c.r,
					g: c.g,
					b: c.b,
					a: c.a,
					midpoint: s.midpoint,
				});
			}
			sv.set(stopsData);
		}

		let uniformBuffer: GPUBuffer;
		let stopsBuffer: GPUBuffer;

		if (cacheable) {
			// Create dedicated buffers owned by the gradient cache
			uniformBuffer = this.deps.device.createBuffer({
				label: `Gradient Cache Uniform [${cacheKey}]`,
				size: uv.arrayBuffer.byteLength,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			stopsBuffer = this.deps.device.createBuffer({
				label: `Gradient Cache Stops [${cacheKey}]`,
				size: sv.arrayBuffer.byteLength,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
		} else {
			// Use pool for uncacheable draws (free gradients, no cacheKey)
			let entry = this.deps.gradient.bufferPool[this.deps.gradient.drawIndex];
			if (!entry) {
				entry = {
					uniformBuffer: this.deps.device.createBuffer({
						label: `Gradient Uniforms #${this.deps.gradient.drawIndex}`,
						size: uv.arrayBuffer.byteLength,
						usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
					}),
					stopsBuffer: this.deps.device.createBuffer({
						label: `Gradient Color Stops #${this.deps.gradient.drawIndex}`,
						size: sv.arrayBuffer.byteLength,
						usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
					}),
				};
				this.deps.gradient.bufferPool.push(entry);
			}

			uniformBuffer = entry.uniformBuffer;
			stopsBuffer = entry.stopsBuffer;
			this.deps.gradient.drawIndex++;
		}

		this.deps.device.queue.writeBuffer(uniformBuffer, 0, uv.arrayBuffer);
		this.deps.device.queue.writeBuffer(stopsBuffer, 0, sv.arrayBuffer);

		const meshPreparedData =
			fill.type === "mesh"
				? this.deps.gradient.meshTextureGenerator.prepareMeshGradientData(fill)
				: null;
		const gradientTexture =
			fill.type === "free"
				? this.deps.gradient.textureGenerator.generateMeshTexture(
						fill,
						256,
						256,
					)
				: fill.type === "pattern" && patternTexture
					? patternTexture
					: this.deps.gradient.placeholderTexture;

		this.deps.gradient.sampler ??= this.deps.device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const gradientBindGroup = this.deps.device.createBindGroup({
			label: "Gradient Bind Group",
			layout: this.deps.gradient.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: stopsBuffer } },
				{ binding: 2, resource: gradientTexture.createView() },
				{ binding: 3, resource: this.deps.gradient.sampler },
				{
					binding: 4,
					resource: {
						buffer:
							meshPreparedData?.vertexBuffer ??
							this.deps.gradient.placeholderStorageBuffer,
					},
				},
				{
					binding: 5,
					resource: {
						buffer:
							meshPreparedData?.faceBuffer ??
							this.deps.gradient.placeholderStorageBuffer,
					},
				},
				{
					binding: 6,
					resource: {
						buffer:
							meshPreparedData?.edgeCurveBuffer ??
							this.deps.gradient.placeholderStorageBuffer,
					},
				},
			],
		});

		// Store in cache (linear/radial only, with dedicated buffers)
		if (cacheable) {
			this.deps.gradientCache.set(cacheKey, {
				uniformBuffer,
				stopsBuffer,
				bindGroup: gradientBindGroup,
				fingerprint,
			});
		}

		return gradientBindGroup;
	}
}

const GRADIENT_TYPE_INDEX: Record<TexturedFill["type"], number> = {
	linear: 1,
	radial: 2,
	free: 3,
	mesh: 4,
	pattern: 5,
};
