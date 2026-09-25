/**
 * A per-frame ring of uniform buffers.
 *
 * A render pass reads its uniforms when the queue executes the command
 * buffer, not when the draw is encoded, so every draw in a frame needs its
 * own buffer — but recreating them per draw allocates continuously while
 * panning. Every pass in the renderer therefore kept the same three lines of
 * bookkeeping: an array of buffers, an index reset at frame start, and a grow
 * on demand. This is that, once.
 *
 * The buffers stay alive across frames; `beginFrame` only rewinds the index,
 * so a steady frame count settles on a fixed set. Reusing a buffer from the
 * previous frame is safe for the same reason the index has to advance within
 * one: by the time the index comes back around, that frame's command buffer
 * has been submitted.
 */
export class FrameUniformPool {
	/** Buffers plus the size they were created at — tracked here rather than
	 *  read back off GPUBuffer.size, which unit-test doubles do not carry. */
	private slots: Array<{ buffer: GPUBuffer; byteLength: number }> = [];
	private index = 0;

	public constructor(
		private readonly device: GPUDevice,
		/** Prefixes each buffer's debug label. */
		private readonly label: string,
	) {}

	/** The slot the next `acquire`/`write` will hand out. Callers that key a
	 *  bind-group cache by buffer identity use it as that key. */
	public get nextIndex(): number {
		return this.index;
	}

	/** Rewind to the first slot. Call once per frame, before any draw. */
	public beginFrame(): void {
		this.index = 0;
	}

	/** The next slot's buffer, at least `byteLength` bytes. */
	public acquire(byteLength: number): GPUBuffer {
		const existing = this.slots[this.index];
		if (existing && existing.byteLength >= byteLength) {
			this.index++;
			return existing.buffer;
		}
		// A slot too small for this call (a pool shared by differently-sized
		// uniform blocks) is replaced outright rather than grown alongside, so
		// the pool stays one buffer per slot.
		existing?.buffer.destroy();
		const buffer = this.device.createBuffer({
			label: `${this.label} [pool ${this.index}]`,
			size: byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.slots[this.index] = { buffer, byteLength };
		this.index++;
		return buffer;
	}

	/** Acquire the next slot and upload `data` into it — the shape almost
	 *  every caller wants. */
	public write(data: ArrayBuffer | ArrayBufferView): GPUBuffer {
		const buffer = this.acquire(data.byteLength);
		this.device.queue.writeBuffer(buffer, 0, data);
		return buffer;
	}

	public destroy(): void {
		for (const slot of this.slots) slot.buffer.destroy();
		this.slots = [];
		this.index = 0;
	}
}
