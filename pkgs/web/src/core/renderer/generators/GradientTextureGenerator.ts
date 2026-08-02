import Delaunator from "delaunator";
import {
	colorToRawRGBA,
	type FreeGradient,
	type FreeGradientStop,
} from "../../schema";

interface CacheEntry {
	texture: GPUTexture;
	lastUsedFrame: number;
}

/**
 * Generates GPU textures for free-form gradients using
 * Delaunay triangulation + triangular Coons Patch interpolation.
 *
 * ## Pipeline
 * 1. Compute Delaunay triangulation from stop positions (CPU, via delaunator).
 * 2. For each Delaunay edge, look up the cubic Bezier control points
 *    from the two endpoint stops' `edgeCPs` entries.
 * 3. Pack stops, triangle indices, and edge CPs into GPU buffers.
 * 4. Dispatch a compute shader that evaluates Coons Patch interpolation
 *    per pixel in OKLab color space.
 *
 * Results are cached keyed by gradient definition hash (including CPs).
 * Textures unused for 10+ frames are automatically evicted.
 */
export class GradientTextureGenerator {
	private device: GPUDevice;
	private computePipeline: GPUComputePipeline;
	private computeBindGroupLayout: GPUBindGroupLayout;
	private textureCache: Map<string, CacheEntry> = new Map();
	private frameCounter = 0;

	// Reusable GPU buffers for compute dispatch
	private computeUniformBuffer: GPUBuffer | null = null;
	private computeStopsBuffer: GPUBuffer | null = null;
	private computeStopsBufferSize = 0;
	private computeTrianglesBuffer: GPUBuffer | null = null;
	private computeTrianglesBufferSize = 0;
	private computeEdgeCPsBuffer: GPUBuffer | null = null;
	private computeEdgeCPsBufferSize = 0;

	private static readonly MAX_CACHE_SIZE = 32;
	private static readonly EVICT_AFTER_FRAMES = 10;
	/** Stop struct: color(4) + pos(2) + pad(2) = 8 floats */
	public static readonly FLOATS_PER_STOP = 8;
	/** EdgeCP struct: cp(2) + pad(2) = 4 floats */
	public static readonly FLOATS_PER_EDGE_CP = 4;

	public constructor(
		device: GPUDevice,
		computePipeline: GPUComputePipeline,
		computeBindGroupLayout: GPUBindGroupLayout,
	) {
		this.device = device;
		this.computePipeline = computePipeline;
		this.computeBindGroupLayout = computeBindGroupLayout;
	}

	/**
	 * Call at the start of each frame. Increments frame counter and evicts
	 * textures unused for EVICT_AFTER_FRAMES frames.
	 *
	 * @returns Array of evicted GPUTextures (caller should invalidate any
	 *          bind groups referencing these textures)
	 */
	public beginFrame(): GPUTexture[] {
		this.frameCounter++;
		const evicted: GPUTexture[] = [];

		for (const [key, entry] of this.textureCache) {
			if (
				this.frameCounter - entry.lastUsedFrame >
				GradientTextureGenerator.EVICT_AFTER_FRAMES
			) {
				entry.texture.destroy();
				evicted.push(entry.texture);
				this.textureCache.delete(key);
			}
		}

		// Enforce max cache size (evict oldest entries)
		if (this.textureCache.size > GradientTextureGenerator.MAX_CACHE_SIZE) {
			const entries = [...this.textureCache.entries()].sort(
				(a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame,
			);
			const toRemove = entries.length - GradientTextureGenerator.MAX_CACHE_SIZE;
			for (let i = 0; i < toRemove; i++) {
				entries[i][1].texture.destroy();
				evicted.push(entries[i][1].texture);
				this.textureCache.delete(entries[i][0]);
			}
		}

		return evicted;
	}

	/**
	 * Generate a GPUTexture containing the rendered free-form gradient.
	 * Results are cached -- repeated calls with identical gradient definitions
	 * return the cached texture without recomputation.
	 */
	public generateMeshTexture(
		gradient: FreeGradient,
		width: number,
		height: number,
		encoder?: GPUCommandEncoder,
	): GPUTexture {
		const cacheKey = computeFreeGradientHash(gradient, width, height);
		const cached = this.textureCache.get(cacheKey);
		if (cached) {
			cached.lastUsedFrame = this.frameCounter;
			return cached.texture;
		}

		const texture = this.dispatchCompute(gradient, width, height, encoder);
		this.textureCache.set(cacheKey, {
			texture,
			lastUsedFrame: this.frameCounter,
		});
		return texture;
	}

	private dispatchCompute(
		gradient: FreeGradient,
		width: number,
		height: number,
		externalEncoder?: GPUCommandEncoder,
	): GPUTexture {
		const { stops } = gradient;
		const stopCount = stops.length;

		// --- Delaunay triangulation (requires ≥ 3 non-collinear points) ---
		let triangleIndices: Uint32Array;
		if (stopCount >= 3) {
			const delaunay = Delaunator.from(stops.map((s) => [s.x, s.y]));
			triangleIndices = new Uint32Array(delaunay.triangles);
		} else {
			triangleIndices = new Uint32Array(0);
		}
		const triangleCount = triangleIndices.length / 3;

		// --- Uniform buffer (create once, reuse) ---
		if (!this.computeUniformBuffer) {
			this.computeUniformBuffer = this.device.createBuffer({
				label: "FreeGradient CoonsPatch Uniforms",
				size: 16, // 4 x u32
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
		}
		this.device.queue.writeBuffer(
			this.computeUniformBuffer,
			0,
			new Uint32Array([width, height, stopCount, triangleCount]),
		);

		// --- Stops storage buffer ---
		const stopData = packStops(stops);
		const stopsNeeded = stopData.byteLength;
		if (!this.computeStopsBuffer || this.computeStopsBufferSize < stopsNeeded) {
			this.computeStopsBuffer?.destroy();
			const allocSize = Math.max(stopsNeeded, 256);
			this.computeStopsBuffer = this.device.createBuffer({
				label: "FreeGradient CoonsPatch Stops",
				size: allocSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.computeStopsBufferSize = allocSize;
		}
		this.device.queue.writeBuffer(
			this.computeStopsBuffer,
			0,
			stopData as GPUAllowSharedBufferSource,
		);

		// --- Triangles storage buffer (flat u32 array, 3 indices per triangle) ---
		// Round up to multiple of 4 bytes (u32 is already 4 bytes, so just ensure min size)
		const triNeeded = Math.max(triangleIndices.byteLength, 4);
		if (
			!this.computeTrianglesBuffer ||
			this.computeTrianglesBufferSize < triNeeded
		) {
			this.computeTrianglesBuffer?.destroy();
			const allocSize = Math.max(triNeeded, 256);
			this.computeTrianglesBuffer = this.device.createBuffer({
				label: "FreeGradient CoonsPatch Triangles",
				size: allocSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.computeTrianglesBufferSize = allocSize;
		}
		if (triangleIndices.byteLength > 0) {
			this.device.queue.writeBuffer(
				this.computeTrianglesBuffer,
				0,
				triangleIndices as GPUAllowSharedBufferSource,
			);
		}

		// --- Edge CPs storage buffer (stopCount * stopCount entries, 4 floats each) ---
		const edgeCPData = packEdgeCPs(stops);
		const edgeCPNeeded = Math.max(edgeCPData.byteLength, 16);
		if (
			!this.computeEdgeCPsBuffer ||
			this.computeEdgeCPsBufferSize < edgeCPNeeded
		) {
			this.computeEdgeCPsBuffer?.destroy();
			const allocSize = Math.max(edgeCPNeeded, 256);
			this.computeEdgeCPsBuffer = this.device.createBuffer({
				label: "FreeGradient CoonsPatch EdgeCPs",
				size: allocSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.computeEdgeCPsBufferSize = allocSize;
		}
		this.device.queue.writeBuffer(
			this.computeEdgeCPsBuffer,
			0,
			edgeCPData as GPUAllowSharedBufferSource,
		);

		// --- Output texture ---
		const texture = this.device.createTexture({
			label: "FreeGradient",
			size: { width, height },
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
		});

		// --- Bind group (5 entries: uniforms, stops, triangles, edgeCPs, output) ---
		const bindGroup = this.device.createBindGroup({
			label: "FreeGradient CoonsPatch Bind Group",
			layout: this.computeBindGroupLayout,
			entries: [
				{
					binding: 0,
					resource: { buffer: this.computeUniformBuffer },
				},
				{
					binding: 1,
					resource: { buffer: this.computeStopsBuffer },
				},
				{
					binding: 2,
					resource: { buffer: this.computeTrianglesBuffer },
				},
				{
					binding: 3,
					resource: { buffer: this.computeEdgeCPsBuffer },
				},
				{ binding: 4, resource: texture.createView() },
			],
		});

		// --- Dispatch compute ---
		const enc =
			externalEncoder ??
			this.device.createCommandEncoder({
				label: "FreeGradient CoonsPatch Encoder",
			});
		const pass = enc.beginComputePass({
			label: "FreeGradient CoonsPatch Pass",
		});
		pass.setPipeline(this.computePipeline);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
		pass.end();
		if (!externalEncoder) {
			this.device.queue.submit([enc.finish()]);
		}

		return texture;
	}

	public destroy(): void {
		for (const entry of this.textureCache.values()) {
			entry.texture.destroy();
		}
		this.textureCache.clear();
		this.computeUniformBuffer?.destroy();
		this.computeUniformBuffer = null;
		this.computeStopsBuffer?.destroy();
		this.computeStopsBuffer = null;
		this.computeTrianglesBuffer?.destroy();
		this.computeTrianglesBuffer = null;
		this.computeEdgeCPsBuffer?.destroy();
		this.computeEdgeCPsBuffer = null;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pack FreeGradientStop array into a flat Float32Array matching the WGSL
 * GradientStop struct layout (8 floats per stop):
 *   [r, g, b, a, x, y, pad0, pad1]
 *
 * color (vec4f) is placed first in the WGSL struct to avoid alignment padding.
 */
function packStops(stops: FreeGradientStop[]): Float32Array {
	const data = new Float32Array(
		stops.length * GradientTextureGenerator.FLOATS_PER_STOP,
	);

	for (let i = 0; i < stops.length; i++) {
		const s = stops[i];
		const { r, g, b, a } = colorToRawRGBA(s.color);
		const off = i * GradientTextureGenerator.FLOATS_PER_STOP;

		data[off] = r;
		data[off + 1] = g;
		data[off + 2] = b;
		data[off + 3] = a;
		data[off + 4] = s.x;
		data[off + 5] = s.y;
	}

	return data;
}

/**
 * Pack edge control points into a flat Float32Array.
 *
 * Layout: stopCount * stopCount entries, indexed as [i * stopCount + j].
 * Each entry is 4 floats: [cpX, cpY, 0, 0] matching the EdgeCP WGSL struct.
 *
 * For pair (i, j), looks up stops[i].edgeCPs?.[stops[j].id].
 * If no CP exists, defaults to linear 1/3 position:
 *   stops[i] + (stops[j] - stops[i]) / 3
 */
function packEdgeCPs(stops: FreeGradientStop[]): Float32Array {
	const n = stops.length;
	const data = new Float32Array(
		n * n * GradientTextureGenerator.FLOATS_PER_EDGE_CP,
	);

	for (let i = 0; i < n; i++) {
		const si = stops[i];
		for (let j = 0; j < n; j++) {
			const off = (i * n + j) * GradientTextureGenerator.FLOATS_PER_EDGE_CP;

			if (i === j) continue; // Leave as zeros

			const sj = stops[j];
			const cp = si.edgeCPs?.[sj.id];
			if (cp) {
				data[off] = cp.x;
				data[off + 1] = cp.y;
			} else {
				// Default: linear 1/3 position from si toward sj
				data[off] = si.x + (sj.x - si.x) / 3;
				data[off + 1] = si.y + (sj.y - si.y) / 3;
			}
		}
	}

	return data;
}

/**
 * Compute a cache key from a FreeGradient definition + output dimensions.
 * Includes edge CP data so that moving CPs invalidates the cache.
 */
function computeFreeGradientHash(
	gradient: FreeGradient,
	width: number,
	height: number,
): string {
	const { stops } = gradient;
	const parts: string[] = [`${width},${height},${stops.length}`];

	for (const s of stops) {
		const { r, g, b, a } = colorToRawRGBA(s.color);
		parts.push(`${s.id},${s.x},${s.y},${r},${g},${b},${a}`);

		if (s.edgeCPs) {
			for (const [targetId, cp] of Object.entries(s.edgeCPs)) {
				parts.push(`cp:${targetId},${cp.x},${cp.y}`);
			}
		}
	}

	return parts.join("|");
}
