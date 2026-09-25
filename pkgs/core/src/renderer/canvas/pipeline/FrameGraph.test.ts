import { describe, expect, it, vi } from "vitest";
import { type FGTextureDesc, FrameGraph } from "./FrameGraph";
import type { TexturePool } from "./TexturePool";

describe("FrameGraph", () => {
	it("should run passes in declaration order", () => {
		const graph = new FrameGraph();
		const order: string[] = [];
		graph.addPass("a", {
			reads: [],
			writes: [],
			neverCull: true,
			execute: () => order.push("a"),
		});
		graph.addPass("b", {
			reads: [],
			writes: [],
			neverCull: true,
			execute: () => order.push("b"),
		});
		graph.addPass("c", {
			reads: [],
			writes: [],
			neverCull: true,
			execute: () => order.push("c"),
		});

		graph.execute(mockEncoder(), mockPool().pool);

		expect(order).toEqual(["a", "b", "c"]);
	});

	it("should resolve imported handles to the wrapped texture", () => {
		const graph = new FrameGraph();
		const external = { label: "prebuf" } as GPUTexture;
		const handle = graph.importTexture(external);
		let resolved: GPUTexture | null = null;
		graph.addPass("read", {
			reads: [handle],
			writes: [],
			neverCull: true,
			execute: (ctx) => {
				resolved = ctx.get(handle);
			},
		});

		const { pool, created, released } = mockPool();
		graph.execute(mockEncoder(), pool);

		expect(resolved).toBe(external);
		// Imported textures are externally owned — never acquired or released.
		expect(created).toHaveLength(0);
		expect(released).toHaveLength(0);
	});

	it("should acquire created textures from the pool and release them after their last pass", () => {
		const graph = new FrameGraph();
		const handle = graph.createTexture(scratchDesc("scratch"));
		let resolved: GPUTexture | null = null;
		graph.addPass("write", {
			reads: [],
			writes: [handle],
			neverCull: true,
			execute: (ctx) => {
				resolved = ctx.get(handle);
			},
		});

		const { pool, created, released } = mockPool();
		graph.execute(mockEncoder(), pool);

		expect(created).toHaveLength(1);
		expect(resolved).toBe(created[0]);
		expect(released).toEqual(created);
	});

	it("should alias created textures with disjoint pass ranges onto one pool texture", () => {
		const graph = new FrameGraph();
		const first = graph.createTexture(scratchDesc("first"));
		const second = graph.createTexture(scratchDesc("second"));
		let resolvedFirst: GPUTexture | null = null;
		let resolvedSecond: GPUTexture | null = null;
		graph.addPass("use-first", {
			reads: [],
			writes: [first],
			neverCull: true,
			execute: (ctx) => {
				resolvedFirst = ctx.get(first);
			},
		});
		graph.addPass("use-second", {
			reads: [],
			writes: [second],
			neverCull: true,
			execute: (ctx) => {
				resolvedSecond = ctx.get(second);
			},
		});

		const { pool, created } = mockPool();
		graph.execute(mockEncoder(), pool);

		// "first" is released after its last pass, so the pool hands the same
		// physical texture back for "second".
		expect(created).toHaveLength(1);
		expect(resolvedSecond).toBe(resolvedFirst);
	});

	it("should keep created textures with overlapping pass ranges distinct", () => {
		const graph = new FrameGraph();
		const a = graph.createTexture(scratchDesc("a"));
		const b = graph.createTexture(scratchDesc("b"));
		let resolvedA: GPUTexture | null = null;
		let resolvedB: GPUTexture | null = null;
		graph.addPass("use-both", {
			reads: [a],
			writes: [b],
			neverCull: true,
			execute: (ctx) => {
				resolvedA = ctx.get(a);
				resolvedB = ctx.get(b);
			},
		});

		const { pool, created } = mockPool();
		graph.execute(mockEncoder(), pool);

		expect(created).toHaveLength(2);
		expect(resolvedA).not.toBe(resolvedB);
	});

	it("should skip passes whose writes reach no observable texture", () => {
		const graph = new FrameGraph();
		const scratch = graph.createTexture(scratchDesc("scratch"));
		let deadRan = false;
		graph.addPass("dead", {
			reads: [],
			writes: [scratch],
			execute: () => {
				deadRan = true;
			},
		});
		const external = { label: "swapchain" } as GPUTexture;
		const root = graph.importTexture(external);
		let liveRan = false;
		graph.addPass("live", {
			reads: [],
			writes: [root],
			execute: () => {
				liveRan = true;
			},
		});

		const { pool, created } = mockPool();
		graph.execute(mockEncoder(), pool);

		expect(deadRan).toBe(false);
		expect(liveRan).toBe(true);
		// The culled pass's scratch texture is never acquired either.
		expect(created).toHaveLength(0);
	});

	it("should keep producers of textures read by surviving passes", () => {
		const graph = new FrameGraph();
		const scratch = graph.createTexture(scratchDesc("scratch"));
		const external = { label: "swapchain" } as GPUTexture;
		const root = graph.importTexture(external);
		const order: string[] = [];
		graph.addPass("produce", {
			reads: [],
			writes: [scratch],
			execute: () => order.push("produce"),
		});
		graph.addPass("consume", {
			reads: [scratch],
			writes: [root],
			execute: () => order.push("consume"),
		});

		graph.execute(mockEncoder(), mockPool().pool);

		expect(order).toEqual(["produce", "consume"]);
	});

	it("should never cull neverCull passes", () => {
		const graph = new FrameGraph();
		let ran = false;
		graph.addPass("side-effect", {
			reads: [],
			writes: [],
			neverCull: true,
			execute: () => {
				ran = true;
			},
		});

		graph.execute(mockEncoder(), mockPool().pool);

		expect(ran).toBe(true);
	});

	it("should reject passes that reference unknown handles", () => {
		const graph = new FrameGraph();
		expect(() =>
			graph.addPass("bad", {
				reads: [99 as never],
				writes: [],
				execute: () => {},
			}),
		).toThrow(/unknown handle/);
	});

	it("should reject a second execute on the same graph", () => {
		const graph = new FrameGraph();
		const { pool } = mockPool();
		graph.execute(mockEncoder(), pool);
		expect(() => graph.execute(mockEncoder(), pool)).toThrow(/twice/);
	});

	it("should reject access to a handle not declared by the executing pass", () => {
		const graph = new FrameGraph();
		const declared = graph.importTexture({ label: "declared" } as GPUTexture);
		const undeclared = graph.importTexture({
			label: "undeclared",
		} as GPUTexture);
		graph.addPass("restricted", {
			reads: [declared],
			writes: [],
			neverCull: true,
			execute: (ctx) => ctx.get(undeclared),
		});

		expect(() => graph.execute(mockEncoder(), mockPool().pool)).toThrow(
			/pass "restricted" accessed undeclared handle/,
		);
	});

	it("should release acquired textures when a pass throws", () => {
		const graph = new FrameGraph();
		const handle = graph.createTexture(scratchDesc("scratch"));
		graph.addPass("throwing", {
			reads: [],
			writes: [handle],
			neverCull: true,
			execute: (ctx) => {
				ctx.view(handle);
				throw new Error("pass failed");
			},
		});
		const { pool, created, released } = mockPool();

		expect(() => graph.execute(mockEncoder(), pool)).toThrow("pass failed");
		expect(released).toEqual(created);
	});
});

// Helpers

function scratchDesc(label: string): FGTextureDesc {
	return {
		label,
		width: 256,
		height: 256,
		format: "rgba8unorm",
		usage: GPUTextureUsage.RENDER_ATTACHMENT,
	};
}

function mockEncoder(): GPUCommandEncoder {
	return {
		label: "encoder",
		beginRenderPass: vi.fn(() => ({ end: vi.fn() })),
	} as unknown as GPUCommandEncoder;
}

/** Mirrors TexturePool's reuse policy: released textures go into a
 *  compatibility bucket and come back on the next matching acquire. */
function mockPool(): {
	pool: TexturePool;
	created: GPUTexture[];
	released: GPUTexture[];
} {
	const created: GPUTexture[] = [];
	const released: GPUTexture[] = [];
	const buckets = new Map<string, GPUTexture[]>();
	const keyOf = (
		width: number,
		height: number,
		format: unknown,
		sampleCount: unknown,
		usage: unknown,
	) => `${width}x${height}x${format}x${sampleCount}x${usage}`;
	const pool = {
		acquire: vi.fn(
			(
				width: number,
				height: number,
				format: unknown,
				sampleCount: unknown,
				usage: number,
				label: string,
			) => {
				const bucket = buckets.get(
					keyOf(width, height, format, sampleCount, usage),
				);
				if (bucket && bucket.length > 0) return bucket.pop()!;
				const texture = {
					label,
					width,
					height,
					format,
					sampleCount,
					usage,
					createView: vi.fn(() => ({}) as GPUTextureView),
				} as unknown as GPUTexture;
				created.push(texture);
				return texture;
			},
		),
		release: vi.fn((texture: GPUTexture) => {
			released.push(texture);
			const key = keyOf(
				texture.width,
				texture.height,
				texture.format,
				texture.sampleCount,
				texture.usage,
			);
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = [];
				buckets.set(key, bucket);
			}
			bucket.push(texture);
		}),
	} as unknown as TexturePool;
	return { pool, created, released };
}
