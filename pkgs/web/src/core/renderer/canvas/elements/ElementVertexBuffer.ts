// Grow-only shared Float32Array to avoid per-frame allocation and GC pressure.
// Each instance resets the write offset to 0; the underlying buffer is reused
// across sequential draw calls (all usages are create → fill → toFloat32Array
// → writeBuffer → discard, never overlapping).

import { UNIFIED_VERTEX_FLOATS } from "../pipeline/unifiedVertexLayout";

// Module-scope scratch buffers for u32<->f32 bit-reinterpret (elementIndex encoding)
const _u32Scratch = new Uint32Array(1);
const _f32Scratch = new Float32Array(_u32Scratch.buffer);
let _sharedVertexBuf = new Float32Array(8192);

export class ElementVertexBuffer {
	private buf: Float32Array;
	private writeOffset = 0;
	private readonly ei: number;

	public constructor(transformIndex: number) {
		_u32Scratch[0] = transformIndex;
		this.ei = _f32Scratch[0];
		this.buf = _sharedVertexBuf;
		this.writeOffset = 0;
	}

	private ensureCapacity(needed: number): void {
		const required = this.writeOffset + needed;
		if (this.buf.length >= required) return;
		const newSize = Math.max(required, this.buf.length * 2);
		const newBuf = new Float32Array(newSize);
		newBuf.set(this.buf.subarray(0, this.writeOffset));
		this.buf = newBuf;
		_sharedVertexBuf = newBuf;
	}

	// The sequential literal writes below follow UNIFIED_VERTEX_OFFSETS;
	// unifiedVertexLayout.test.ts pins each component's position to that metadata.
	public pushFill(
		x: number,
		y: number,
		r: number,
		g: number,
		b: number,
		a: number,
		offsetX = 0,
		offsetY = 0,
	): void {
		this.ensureCapacity(UNIFIED_VERTEX_FLOATS);
		const off = this.writeOffset;
		this.buf[off] = x;
		this.buf[off + 1] = y;
		this.buf[off + 2] = r;
		this.buf[off + 3] = g;
		this.buf[off + 4] = b;
		this.buf[off + 5] = a;
		this.buf[off + 6] = offsetX;
		this.buf[off + 7] = offsetY;
		this.buf[off + 8] = this.ei;
		this.writeOffset += UNIFIED_VERTEX_FLOATS;
	}

	public pushGradient(
		x: number,
		y: number,
		alpha: number,
		offsetX = 0,
		offsetY = 0,
	): void {
		this.pushGradientTU(x, y, 0, 0, alpha, offsetX, offsetY);
	}

	/**
	 * Gradient vertex carrying stroke-gradient params in the unused color
	 * channels: t (along-stroke arc ratio) in r, u (cross-stroke 0..1) in g.
	 * The shader reads them only when strokeGradientMode is along/across.
	 */
	public pushGradientTU(
		x: number,
		y: number,
		t: number,
		u: number,
		alpha: number,
		offsetX = 0,
		offsetY = 0,
	): void {
		this.ensureCapacity(UNIFIED_VERTEX_FLOATS);
		const off = this.writeOffset;
		this.buf[off] = x;
		this.buf[off + 1] = y;
		this.buf[off + 2] = t;
		this.buf[off + 3] = u;
		this.buf[off + 4] = 0;
		this.buf[off + 5] = alpha;
		this.buf[off + 6] = offsetX;
		this.buf[off + 7] = offsetY;
		this.buf[off + 8] = this.ei;
		this.writeOffset += UNIFIED_VERTEX_FLOATS;
	}

	public get vertexCount(): number {
		return this.writeOffset / UNIFIED_VERTEX_FLOATS;
	}

	public get length(): number {
		return this.writeOffset;
	}

	public toFloat32Array(): Float32Array {
		return this.buf.subarray(0, this.writeOffset);
	}

	/** Copy the written vertices for storage beyond the next buffer build. */
	public toOwnedFloat32Array(): Float32Array {
		return this.buf.slice(0, this.writeOffset);
	}

	/** Wrap a previously cached Float32Array as a read-only vertex buffer. */
	public static fromFloat32Array(
		data: Float32Array,
		vertexCount: number,
		transformIndex: number,
	): ElementVertexBuffer {
		const buf = new ElementVertexBuffer(transformIndex);
		buf.buf = data;
		buf.writeOffset = vertexCount * UNIFIED_VERTEX_FLOATS;
		return buf;
	}
}
