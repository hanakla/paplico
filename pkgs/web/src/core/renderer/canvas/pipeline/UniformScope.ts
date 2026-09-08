import type { Viewport } from "../../../schema";
import type { StructuredView } from "../../../utils/wgpu-utils";
import type { RasterFrame } from "../../geometry/strips/stripTypes";

export interface UniformEntry {
	buffer: GPUBuffer;
	bindGroup: GPUBindGroup;
	/** The texel space the uniform describes; CPU rasterization targets it. */
	frame: RasterFrame;
}

/**
 * Per-pass uniform buffer pool.
 *
 * Each offscreen (or export) render pass needs its own viewport uniform
 * values.  Instead of overwriting a single shared buffer and issuing a
 * separate `queue.submit` before the next pass can start, UniformScope
 * hands out a fresh {buffer, bindGroup} pair per pass.
 *
 * At the start of each frame, call `resetFrame()` to recycle all pairs.
 * The underlying GPU buffers are reused across frames.
 */
export class UniformScope {
	private readonly pool: UniformEntry[] = [];
	private index = 0;

	public constructor(
		private readonly device: GPUDevice,
		private readonly bindGroupLayout: GPUBindGroupLayout,
		private readonly viewportUniformView: StructuredView,
	) {}

	/**
	 * Acquire a uniform buffer + bind group pair pre-filled with the given
	 * viewport parameters.  The returned bind group can be passed directly
	 * to `passEncoder.setBindGroup(0, ...)`.
	 */
	public acquire(
		viewport: Viewport,
		width: number,
		height: number,
	): UniformEntry {
		if (this.index >= this.pool.length) {
			this.pool.push(this.createEntry());
		}

		const entry = this.pool[this.index++];
		entry.frame = { viewport: { ...viewport }, width, height };

		this.viewportUniformView.set({
			viewportX: viewport.x,
			viewportY: viewport.y,
			zoom: viewport.zoom,
			canvasWidth: width,
			canvasHeight: height,
			rotSin: -Math.sin(viewport.rotation),
			rotCos: Math.cos(viewport.rotation),
		});
		this.device.queue.writeBuffer(
			entry.buffer,
			0,
			this.viewportUniformView.arrayBuffer,
		);

		return entry;
	}

	/** Recycle all entries for the next frame. */
	public resetFrame(): void {
		this.index = 0;
	}

	public destroy(): void {
		for (const entry of this.pool) {
			entry.buffer.destroy();
		}
		this.pool.length = 0;
		this.index = 0;
	}

	private createEntry(): UniformEntry {
		const buffer = this.device.createBuffer({
			label: `UniformScope Buffer [${this.pool.length}]`,
			size: this.viewportUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const bindGroup = this.device.createBindGroup({
			label: `UniformScope BindGroup [${this.pool.length}]`,
			layout: this.bindGroupLayout,
			entries: [{ binding: 0, resource: { buffer } }],
		});

		return {
			buffer,
			bindGroup,
			frame: {
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				width: 1,
				height: 1,
			},
		};
	}
}
