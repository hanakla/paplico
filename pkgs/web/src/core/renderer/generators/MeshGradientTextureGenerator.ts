import {
	colorToRawRGBA,
	type MeshFace,
	type MeshGradient,
	type MeshGradientVertex,
} from "../../schema";
import { getEffectiveMeshEdgeCurve } from "../../utils/geometry/meshGradient";

interface TextureCacheEntry {
	texture: GPUTexture;
	lastUsedFrame: number;
}

interface PreparedCacheEntry {
	data: PreparedMeshGradientData;
	lastUsedFrame: number;
}

export interface PreparedMeshGradientData {
	vertexBuffer: GPUBuffer;
	faceBuffer: GPUBuffer;
	edgeCurveBuffer: GPUBuffer;
	faceCount: number;
}

/** Vertex struct: color(4) + pos(2) + pad(2) = 8 floats. */
const FLOATS_PER_VERT = 8;
/** Face struct: 12 u32/f32 words (faceType, vertCount, i0..i3, bboxMinX/Y/MaxX/Y, pad0, pad1). */
const WORDS_PER_FACE = 12;
/** EdgeCurve struct per edge: p0..p3 = 8 floats. 4 edges per face (tri pads the 4th). */
const FLOATS_PER_CURVE = 8;
const EDGES_PER_FACE = 4;

/**
 * Generates GPU textures for mesh gradients using the
 * "Bézier polygon hit + Coons Patch color (no holes)" algorithm.
 *
 * Results are cached by gradient definition hash. Textures unused for 10+
 * frames are evicted.
 */
export class MeshGradientTextureGenerator {
	private device: GPUDevice;
	private textureCache: Map<string, TextureCacheEntry> = new Map();
	private preparedDataCache: Map<string, PreparedCacheEntry> = new Map();
	private frameCounter = 0;

	private static readonly MAX_CACHE_SIZE = 32;
	private static readonly EVICT_AFTER_FRAMES = 10;

	public constructor(device: GPUDevice) {
		this.device = device;
	}

	public beginFrame(): GPUTexture[] {
		this.frameCounter++;
		const evicted: GPUTexture[] = [];

		for (const [key, entry] of this.textureCache) {
			if (
				this.frameCounter - entry.lastUsedFrame >
				MeshGradientTextureGenerator.EVICT_AFTER_FRAMES
			) {
				entry.texture.destroy();
				evicted.push(entry.texture);
				this.textureCache.delete(key);
			}
		}

		if (this.textureCache.size > MeshGradientTextureGenerator.MAX_CACHE_SIZE) {
			const entries = [...this.textureCache.entries()].sort(
				(a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame,
			);
			const toRemove =
				entries.length - MeshGradientTextureGenerator.MAX_CACHE_SIZE;
			for (let i = 0; i < toRemove; i++) {
				entries[i][1].texture.destroy();
				evicted.push(entries[i][1].texture);
				this.textureCache.delete(entries[i][0]);
			}
		}

		for (const [key, entry] of this.preparedDataCache) {
			if (
				this.frameCounter - entry.lastUsedFrame >
				MeshGradientTextureGenerator.EVICT_AFTER_FRAMES
			) {
				entry.data.vertexBuffer.destroy();
				entry.data.faceBuffer.destroy();
				entry.data.edgeCurveBuffer.destroy();
				this.preparedDataCache.delete(key);
			}
		}

		if (
			this.preparedDataCache.size > MeshGradientTextureGenerator.MAX_CACHE_SIZE
		) {
			const entries = [...this.preparedDataCache.entries()].sort(
				(a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame,
			);
			const toRemove =
				entries.length - MeshGradientTextureGenerator.MAX_CACHE_SIZE;
			for (let i = 0; i < toRemove; i++) {
				entries[i][1].data.vertexBuffer.destroy();
				entries[i][1].data.faceBuffer.destroy();
				entries[i][1].data.edgeCurveBuffer.destroy();
				this.preparedDataCache.delete(entries[i][0]);
			}
		}

		return evicted;
	}

	public prepareMeshGradientData(
		gradient: MeshGradient,
	): PreparedMeshGradientData {
		const cacheKey = computeMeshGradientHash(gradient);
		const cached = this.preparedDataCache.get(cacheKey);
		if (cached) {
			cached.lastUsedFrame = this.frameCounter;
			return cached.data;
		}

		const { vertices, faces } = gradient;
		const { vertData, faceWords, curveData } = packGPUData(vertices, faces);
		const vertexBuffer = this.device.createBuffer({
			label: "MeshGradient Prepared Vertices",
			size: Math.max(vertData.byteLength, 256),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		if (vertData.byteLength > 0) {
			this.device.queue.writeBuffer(
				vertexBuffer,
				0,
				vertData as GPUAllowSharedBufferSource,
			);
		}

		const faceBuffer = this.device.createBuffer({
			label: "MeshGradient Prepared Faces",
			size: Math.max(faceWords.byteLength, 256),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		if (faceWords.byteLength > 0) {
			this.device.queue.writeBuffer(
				faceBuffer,
				0,
				faceWords as GPUAllowSharedBufferSource,
			);
		}

		const edgeCurveBuffer = this.device.createBuffer({
			label: "MeshGradient Prepared Curves",
			size: Math.max(curveData.byteLength, 256),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		if (curveData.byteLength > 0) {
			this.device.queue.writeBuffer(
				edgeCurveBuffer,
				0,
				curveData as GPUAllowSharedBufferSource,
			);
		}

		const data: PreparedMeshGradientData = {
			vertexBuffer,
			faceBuffer,
			edgeCurveBuffer,
			faceCount: faces.length,
		};
		this.preparedDataCache.set(cacheKey, {
			data,
			lastUsedFrame: this.frameCounter,
		});
		return data;
	}

	public destroy(): void {
		for (const entry of this.textureCache.values()) {
			entry.texture.destroy();
		}
		this.textureCache.clear();
		for (const entry of this.preparedDataCache.values()) {
			entry.data.vertexBuffer.destroy();
			entry.data.faceBuffer.destroy();
			entry.data.edgeCurveBuffer.destroy();
		}
		this.preparedDataCache.clear();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Curve {
	p0: { x: number; y: number };
	p1: { x: number; y: number };
	p2: { x: number; y: number };
	p3: { x: number; y: number };
}

function toCurve(curve: ReturnType<typeof getEffectiveMeshEdgeCurve>): Curve {
	return {
		p0: curve[0],
		p1: curve[1],
		p2: curve[2],
		p3: curve[3],
	};
}

function evalCurve(curve: Curve, t: number): [number, number] {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return [
		mt2 * mt * curve.p0.x +
			3 * mt2 * t * curve.p1.x +
			3 * mt * t2 * curve.p2.x +
			t2 * t * curve.p3.x,
		mt2 * mt * curve.p0.y +
			3 * mt2 * t * curve.p1.y +
			3 * mt * t2 * curve.p2.y +
			t2 * t * curve.p3.y,
	];
}

/**
 * Pack vertices + faces + edge curves into the three GPU buffer layouts
 * expected by meshGradientCompute.wgsl.ts.
 *
 * Note: quad edges are reordered on the GPU side (edges 2 & 3 reversed) so
 * that the inverse Coons map receives edges consistent with the (u, v)
 * parametrization. Triangle faces leave the 4th edge slot zeroed.
 */
function packGPUData(vertices: MeshGradientVertex[], faces: MeshFace[]) {
	const vertData = new Float32Array(vertices.length * FLOATS_PER_VERT);
	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		const { r, g, b, a } = colorToRawRGBA(v.color);
		const off = i * FLOATS_PER_VERT;
		vertData[off] = r;
		vertData[off + 1] = g;
		vertData[off + 2] = b;
		vertData[off + 3] = a;
		vertData[off + 4] = v.x;
		vertData[off + 5] = v.y;
	}

	const faceWords = new ArrayBuffer(faces.length * WORDS_PER_FACE * 4);
	const faceU32 = new Uint32Array(faceWords);
	const faceF32 = new Float32Array(faceWords);

	const curveData = new Float32Array(
		faces.length * EDGES_PER_FACE * FLOATS_PER_CURVE,
	);

	for (let fi = 0; fi < faces.length; fi++) {
		const face = faces[fi];
		const vs = face.verts;
		const isQuad = face.type === "quad";
		const n = vs.length;
		const fOff = fi * WORDS_PER_FACE;

		faceU32[fOff] = isQuad ? 0 : 1;
		faceU32[fOff + 1] = n;
		faceU32[fOff + 2] = vs[0];
		faceU32[fOff + 3] = vs[1];
		faceU32[fOff + 4] = n > 2 ? vs[2] : 0;
		faceU32[fOff + 5] = n > 3 ? vs[3] : 0;

		let bMinX = 1;
		let bMinY = 1;
		let bMaxX = 0;
		let bMaxY = 0;
		const edgeCount = isQuad ? 4 : 3;
		for (let e = 0; e < edgeCount; e++) {
			const i = vs[e];
			const j = vs[(e + 1) % n];
			const curve = toCurve(getEffectiveMeshEdgeCurve(vertices, faces, i, j));
			const cOff = (fi * EDGES_PER_FACE + e) * FLOATS_PER_CURVE;
			curveData[cOff] = curve.p0.x;
			curveData[cOff + 1] = curve.p0.y;
			curveData[cOff + 2] = curve.p1.x;
			curveData[cOff + 3] = curve.p1.y;
			curveData[cOff + 4] = curve.p2.x;
			curveData[cOff + 5] = curve.p2.y;
			curveData[cOff + 6] = curve.p3.x;
			curveData[cOff + 7] = curve.p3.y;
			for (let s = 0; s <= 8; s++) {
				const t = s / 8;
				const [x, y] = evalCurve(curve, t);
				if (x < bMinX) bMinX = x;
				if (y < bMinY) bMinY = y;
				if (x > bMaxX) bMaxX = x;
				if (y > bMaxY) bMaxY = y;
			}
		}
		if (isQuad) {
			const cOff2 = (fi * EDGES_PER_FACE + 2) * FLOATS_PER_CURVE;
			const cOff3 = (fi * EDGES_PER_FACE + 3) * FLOATS_PER_CURVE;
			// Reverse edge 2: (p0,p1,p2,p3) → (p3,p2,p1,p0)
			swap(curveData, cOff2 + 0, cOff2 + 6);
			swap(curveData, cOff2 + 1, cOff2 + 7);
			swap(curveData, cOff2 + 2, cOff2 + 4);
			swap(curveData, cOff2 + 3, cOff2 + 5);
			// Reverse edge 3
			swap(curveData, cOff3 + 0, cOff3 + 6);
			swap(curveData, cOff3 + 1, cOff3 + 7);
			swap(curveData, cOff3 + 2, cOff3 + 4);
			swap(curveData, cOff3 + 3, cOff3 + 5);
		}

		const gpuMargin = 0.02;
		faceF32[fOff + 6] = bMinX - gpuMargin;
		faceF32[fOff + 7] = bMinY - gpuMargin;
		faceF32[fOff + 8] = bMaxX + gpuMargin;
		faceF32[fOff + 9] = bMaxY + gpuMargin;
	}

	return { vertData, faceWords, curveData };
}

function swap(arr: Float32Array, a: number, b: number): void {
	const t = arr[a];
	arr[a] = arr[b];
	arr[b] = t;
}

function computeMeshGradientHash(
	gradient: MeshGradient,
	width?: number,
	height?: number,
): string {
	const { vertices, faces } = gradient;
	const parts: string[] = [
		`${width ?? 0},${height ?? 0},${vertices.length},${faces.length}`,
	];

	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		const { r, g, b, a } = colorToRawRGBA(v.color);
		const hiddenFlag = v.hidden ? 1 : 0;
		parts.push(`v${i}:${v.x},${v.y},${r},${g},${b},${a},h${hiddenFlag}`);
		if (v.handles) {
			for (const [k, cp] of Object.entries(v.handles)) {
				parts.push(`h${i}->${k}:${cp.x},${cp.y}`);
			}
		}
	}
	for (let fi = 0; fi < faces.length; fi++) {
		const f = faces[fi];
		parts.push(`f${fi}:${f.type},${f.verts.join(",")}`);
	}

	return parts.join("|");
}
