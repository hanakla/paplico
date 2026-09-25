import type { TexturePool } from "./TexturePool";

/**
 * FrameGraph — declarative frame composition for the canvas renderer.
 *
 * A frame is described as passes (nodes) over virtual texture handles
 * (edges) and then executed. A "pass" here is an encoding span between
 * pass breaks, not a single GPURenderPassEncoder: an execute callback may
 * open and close several GPU passes (capture, pyramid, mask, blit) as long
 * as its resource reads/writes are declared.
 *
 * The compiler runs passes in declaration order, culls dead passes
 * (whose writes reach no imported texture through the read chain and
 * that carry no neverCull protection), and performs lifetime interval
 * allocation for created handles: each is acquired from the TexturePool
 * right before its first surviving pass and released right after its
 * last one, so handles with disjoint pass ranges share one physical
 * texture (the pool hands a just-released texture back on the next
 * compatible acquire; same-submit hazards are tracked by WebGPU).
 * Load/store resolution builds on this in a later phase — declaring
 * reads/writes precisely is what makes it possible.
 */

declare const FG_TEXTURE_BRAND: unique symbol;
/** Opaque virtual-texture id. Resolve to a GPUTexture via ctx.get(). */
export type FGTextureHandle = number & { readonly [FG_TEXTURE_BRAND]: true };

export interface FGTextureDesc {
	label: string;
	width: number;
	height: number;
	format: GPUTextureFormat;
	usage: GPUTextureUsageFlags;
	sampleCount?: number;
}

export interface FGExecuteContext {
	readonly encoder: GPUCommandEncoder;
	/** Resolve a handle to its physical texture. Valid only inside a pass
	 *  that declared the handle in reads/writes — a created texture exists
	 *  only within its first-use..last-use pass range. Resolving through the
	 *  context (rather than capturing a raw GPUTexture in the closure) keeps a
	 *  pass's real resource accesses in step with its declared reads/writes, so
	 *  lifetime analysis and future aliasing stay correct. */
	get(handle: FGTextureHandle): GPUTexture;
	/** A fresh default view of the handle's texture. Same validity rules as
	 *  get(); not cached, so a created texture's view never outlives its pass. */
	view(handle: FGTextureHandle): GPUTextureView;
}

interface FGPassDesc {
	reads: readonly FGTextureHandle[];
	writes: readonly FGTextureHandle[];
	/** Protect from dead-pass culling (G3): side effects the graph cannot
	 *  see, e.g. wet-ink simulation updates or cache bakes. */
	neverCull?: boolean;
	execute(ctx: FGExecuteContext): void;
}

interface FGPass {
	name: string;
	desc: FGPassDesc;
}

type FGTextureSlot =
	| { kind: "imported"; texture: GPUTexture; label: string }
	| { kind: "created"; desc: FGTextureDesc; texture: GPUTexture | null };

/**
 * Single-frame graph: build (createTexture/importTexture/addPass), then
 * execute once. Instances are cheap — construct a fresh one per frame.
 */
export class FrameGraph {
	private readonly slots: FGTextureSlot[] = [];
	private readonly passes: FGPass[] = [];
	private executed = false;

	/** Declare a frame-transient texture, physically acquired at execute. */
	public createTexture(desc: FGTextureDesc): FGTextureHandle {
		this.slots.push({ kind: "created", desc, texture: null });
		return (this.slots.length - 1) as FGTextureHandle;
	}

	/** Wrap an externally-owned texture (prebuf, swapchain, persistent
	 *  caches). The graph never acquires or releases it. */
	public importTexture(texture: GPUTexture, label?: string): FGTextureHandle {
		this.slots.push({
			kind: "imported",
			texture,
			label: label ?? texture.label,
		});
		return (this.slots.length - 1) as FGTextureHandle;
	}

	public addPass(name: string, desc: FGPassDesc): void {
		for (const handle of [...desc.reads, ...desc.writes]) {
			if (this.slots[handle] === undefined) {
				throw new Error(
					`FrameGraph: pass "${name}" uses unknown handle ${handle}`,
				);
			}
		}
		this.passes.push({ name, desc });
	}

	/** Run passes in declaration order, skipping dead ones (whose writes
	 *  reach no observable texture) and acquiring each created texture
	 *  before its first surviving pass / releasing it after its last —
	 *  disjoint lifetimes alias onto one pool texture. */
	public execute(encoder: GPUCommandEncoder, pool: TexturePool): void {
		if (this.executed) {
			throw new Error("FrameGraph: execute() called twice on one graph");
		}
		this.executed = true;

		// Dead-pass culling: a pass survives if it is neverCull-protected or
		// writes an observable texture — an imported one (externally visible)
		// or a created one some later surviving pass reads. Walking backwards
		// lets each consumer mark its producers alive through the created
		// handles it reads (passes only ever read earlier passes' writes).
		const aliveHandles = new Set<FGTextureHandle>();
		const alive: boolean[] = new Array(this.passes.length).fill(false);
		for (let i = this.passes.length - 1; i >= 0; i--) {
			const desc = this.passes[i].desc;
			const observable =
				desc.neverCull ||
				desc.writes.some(
					(h) => this.slots[h]?.kind === "imported" || aliveHandles.has(h),
				);
			if (!observable) continue;
			alive[i] = true;
			for (const h of desc.reads) {
				if (this.slots[h]?.kind === "created") {
					aliveHandles.add(h);
				}
			}
		}

		// Lifetime intervals over the surviving passes only — a texture used
		// exclusively by culled passes is never acquired.
		const acquireAt: FGTextureHandle[][] = this.passes.map(() => []);
		const lastUse = new Map<FGTextureHandle, number>();
		this.passes.forEach((pass, i) => {
			if (!alive[i]) return;
			for (const handle of [...pass.desc.reads, ...pass.desc.writes]) {
				if (this.slots[handle]?.kind !== "created") continue;
				if (!lastUse.has(handle)) acquireAt[i].push(handle);
				lastUse.set(handle, i);
			}
		});
		const releaseAt: FGTextureHandle[][] = this.passes.map(() => []);
		for (const [handle, i] of lastUse) {
			releaseAt[i].push(handle);
		}

		const slots = this.slots;
		const resolve = (handle: FGTextureHandle): GPUTexture => {
			const slot = slots[handle];
			if (!slot) throw new Error(`FrameGraph: unknown handle ${handle}`);
			if (slot.kind === "imported") return slot.texture;
			if (!slot.texture) {
				throw new Error(
					`FrameGraph: created texture "${slot.desc.label}" resolved outside its pass range`,
				);
			}
			return slot.texture;
		};
		try {
			for (let i = 0; i < this.passes.length; i++) {
				if (!alive[i]) continue;
				for (const handle of acquireAt[i]) {
					const slot = slots[handle];
					if (slot.kind !== "created") continue;
					slot.texture = pool.acquire(
						slot.desc.width,
						slot.desc.height,
						slot.desc.format,
						slot.desc.sampleCount ?? 1,
						slot.desc.usage,
						slot.desc.label,
					);
				}

				const pass = this.passes[i];
				const declared = new Set([...pass.desc.reads, ...pass.desc.writes]);
				const resolveForPass = (handle: FGTextureHandle): GPUTexture => {
					if (!declared.has(handle)) {
						throw new Error(
							`FrameGraph: pass "${pass.name}" accessed undeclared handle ${handle}`,
						);
					}
					return resolve(handle);
				};
				pass.desc.execute({
					encoder,
					get: resolveForPass,
					view: (handle) => resolveForPass(handle).createView(),
				});
				for (const handle of releaseAt[i]) {
					const slot = slots[handle];
					if (slot.kind !== "created" || !slot.texture) continue;
					pool.release(slot.texture);
					slot.texture = null;
				}
			}
		} finally {
			for (const slot of slots) {
				if (slot.kind !== "created" || !slot.texture) continue;
				pool.release(slot.texture);
				slot.texture = null;
			}
		}
	}
}
