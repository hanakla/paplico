/** Grow-only line-segment storage with no per-line objects. */
export class LineArena {
	public xs0 = new Float32Array(1024);
	public ys0 = new Float32Array(1024);
	public xs1 = new Float32Array(1024);
	public ys1 = new Float32Array(1024);
	public count = 0;

	public push(x0: number, y0: number, x1: number, y1: number): void {
		if (this.count === this.xs0.length) this.grow();
		const i = this.count++;
		this.xs0[i] = x0;
		this.ys0[i] = y0;
		this.xs1[i] = x1;
		this.ys1[i] = y1;
	}

	public reset(): void {
		this.count = 0;
	}

	private grow(): void {
		const next = this.xs0.length * 2;
		this.xs0 = growFloat32(this.xs0, next);
		this.ys0 = growFloat32(this.ys0, next);
		this.xs1 = growFloat32(this.xs1, next);
		this.ys1 = growFloat32(this.ys1, next);
	}
}

function growFloat32(
	src: Float32Array,
	length: number,
): Float32Array<ArrayBuffer> {
	const dst = new Float32Array(length);
	dst.set(src);
	return dst;
}

export function growUint32(
	src: Uint32Array,
	length: number,
): Uint32Array<ArrayBuffer> {
	const dst = new Uint32Array(length);
	dst.set(src);
	return dst;
}

export function growUint8(
	src: Uint8Array,
	length: number,
): Uint8Array<ArrayBuffer> {
	const dst = new Uint8Array(length);
	dst.set(src);
	return dst;
}

export function growInt32(
	src: Int32Array,
	length: number,
): Int32Array<ArrayBuffer> {
	const dst = new Int32Array(length);
	dst.set(src);
	return dst;
}
