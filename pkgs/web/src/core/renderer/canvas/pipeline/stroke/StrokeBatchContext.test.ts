import { describe, expect, it, vi } from "vitest";
import { normalizeBrushSettings } from "../../../../brush/normalize";
import { createDefaultTransform } from "../../../../document/factory";
import type {
	Path,
	PathSegment,
	ScatterBrushSettings,
	StrokeAppearance,
} from "../../../../schema";
import { StampCache } from "../../caches/StampCache";
import type { BrushTextureManager } from "../brush/BrushTextureManager";
import {
	generateStampsDirect,
	NIB_SHAPE_CIRCLE,
} from "../brush/StampGenerator";
import { StrokeBatchContext } from "./StrokeBatchContext";

vi.mock("../brush/DabEvaluator", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../brush/DabEvaluator")>();
	return { ...mod, evaluateDabs: vi.fn(mod.evaluateDabs) };
});

/** Buffer labels distinguishing the two stamp sources in a draw. */
const RESIDENT_STAMPS = "Resident Stamp Instances";
const POOLED_STAMPS = "Stamp Instance Buffer (Pooled)";

const SHORT_LENGTH = 60;
const LONG_LENGTH = 400;

describe("StrokeBatchContext", () => {
	describe("batch flush with a full resident stamp store", () => {
		it("should draw strokes past the store cap through the pooled path in paint order", () => {
			const short = stampCountFor(SHORT_LENGTH);
			const long = stampCountFor(LONG_LENGTH);
			expect(long).toBeGreaterThan(short);

			// The store fits exactly two short strokes; the long one overflows.
			const { context } = createContext({ maxResidentStamps: short * 2 });
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "a", SHORT_LENGTH);
			addStroke(context, "b", LONG_LENGTH);
			addStroke(context, "c", SHORT_LENGTH);

			const { passEncoder, draws } = createPassEncoder();
			context.flushBatch(passEncoder, "main", transformsBindGroup());

			// resident run -> pooled fallback -> next resident run, in exactly
			// the queued paint order — the overflow stroke is NOT dropped.
			expect(draws()).toEqual([
				{ source: RESIDENT_STAMPS, instanceCount: short, firstInstance: 0 },
				{ source: POOLED_STAMPS, instanceCount: long, firstInstance: 0 },
				{
					source: RESIDENT_STAMPS,
					instanceCount: short,
					firstInstance: short,
				},
			]);
		});

		it("should not consume meta/stops store space for strokes the stamp store cannot take", () => {
			const short = stampCountFor(SHORT_LENGTH);
			const { context, buffers, writes } = createContext({
				maxResidentStamps: short,
			});
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "resident", SHORT_LENGTH); // fills the store exactly

			const metaBuffer = findBuffer(buffers, "Resident Stamp Path Metas");
			const stopsBuffer = findBuffer(buffers, "Resident Stamp Color Stops");
			const metaWrites = countWrites(writes, metaBuffer);
			const stopsWrites = countWrites(writes, stopsBuffer);
			expect(metaWrites).toBeGreaterThan(0);
			expect(stopsWrites).toBeGreaterThan(0);

			for (let i = 0; i < 40; i++) {
				addStroke(context, `overflow-${i}`, SHORT_LENGTH);
			}

			// The overflow burst wrote NOTHING to the resident meta/stops
			// stores and did not grow them.
			expect(countWrites(writes, metaBuffer)).toBe(metaWrites);
			expect(countWrites(writes, stopsBuffer)).toBe(stopsWrites);
			expect(
				buffers.filter((b) => b.label === "Resident Stamp Path Metas"),
			).toHaveLength(1);
			expect(
				buffers.filter((b) => b.label === "Resident Stamp Color Stops"),
			).toHaveLength(1);

			// Every stroke still draws: one resident run + 40 pooled fallbacks.
			const { passEncoder, draws } = createPassEncoder();
			context.flushBatch(passEncoder, "main", transformsBindGroup());
			const flushed = draws();
			expect(flushed).toHaveLength(41);
			expect(flushed[0].source).toBe(RESIDENT_STAMPS);
			expect(flushed.slice(1).every((d) => d.source === POOLED_STAMPS)).toBe(
				true,
			);
		});

		it("should retry residency on a later frame once store space frees", () => {
			const short = stampCountFor(SHORT_LENGTH);
			const { context, stampCache } = createContext({
				maxResidentStamps: short,
			});

			// Frame 1: A takes the whole store; B overflows to the pooled path
			// (and must NOT be committed as resident).
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "a", SHORT_LENGTH);
			addStroke(context, "b", SHORT_LENGTH);
			const frame1 = createPassEncoder();
			context.flushBatch(frame1.passEncoder, "main", transformsBindGroup());
			expect(frame1.draws().map((d) => d.source)).toEqual([
				RESIDENT_STAMPS,
				POOLED_STAMPS,
			]);

			// Evict A — its stamp lease returns at the next frame boundary.
			const aKey = [...stampCache.keys()].find((key) => key.startsWith("a:"));
			if (!aKey) throw new Error("test setup: stroke A was not cached");
			stampCache.deleteMany([aKey]);

			// Frame 2: the SAME cached entry for B becomes resident naturally.
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "b", SHORT_LENGTH);
			const frame2 = createPassEncoder();
			context.flushBatch(frame2.passEncoder, "main", transformsBindGroup());
			expect(frame2.draws()).toEqual([
				{ source: RESIDENT_STAMPS, instanceCount: short, firstInstance: 0 },
			]);
		});
	});

	describe("texture-array brush parity between resident and overflow paths", () => {
		it("should upload identical stamp data and bind the same texture array through both paths", () => {
			const count = stampCountFor(SHORT_LENGTH);
			// The store fits exactly the first stroke; the second overflows to
			// the pooled path.
			const { context, writes } = createContext({ maxResidentStamps: count });
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "a", SHORT_LENGTH, SCATTER_ARRAY);
			addStroke(context, "b", SHORT_LENGTH, SCATTER_ARRAY);

			const { passEncoder, draws, drawBindGroup0s } = createPassEncoder();
			context.flushBatch(passEncoder, "main", transformsBindGroup());

			expect(draws().map((d) => d.source)).toEqual([
				RESIDENT_STAMPS,
				POOLED_STAMPS,
			]);

			// Both draws bind the SAME texture array as a 2d-array view.
			const [residentView, pooledView] = drawBindGroup0s().map(textureViewOf);
			expect(residentView.dimension).toBe("2d-array");
			expect(pooledView.dimension).toBe("2d-array");
			expect(pooledView.texture).toBe(residentView.texture);

			// The uploaded stamp floats are identical: the overflow stroke
			// uploads its generated buffer with the resident path's layer
			// packing (the resident bake wrote meta index 0, which IS the
			// pooled per-draw meta index).
			const residentData = writes.find(
				(w) => w.buffer.label === RESIDENT_STAMPS,
			)?.data;
			const pooledData = writes.find(
				(w) => w.buffer.label === POOLED_STAMPS,
			)?.data;
			expect(residentData).toBeDefined();
			expect(pooledData).toEqual(residentData);
			// Fixture guard: some stamp must carry a non-zero packed layer, or
			// the parity assertion would pass with layers dropped entirely.
			expect(residentData && hasNonZeroPackedLayer(residentData)).toBe(true);
		});
	});

	describe("strokes over the stamp cache budget", () => {
		it("should draw through the pooled path without leaving an ownerless resident lease", () => {
			const short = stampCountFor(SHORT_LENGTH);
			const long = stampCountFor(LONG_LENGTH);
			// The long stroke's generated buffer alone exceeds the cache
			// budget; the short one (plus its resident accounting overhead)
			// stays well inside.
			const cacheMaxBytes = generatedDataBytesFor(LONG_LENGTH) - 1;
			expect(generatedDataBytesFor(SHORT_LENGTH) + 256).toBeLessThan(
				cacheMaxBytes,
			);
			const { context, buffers } = createContext({
				maxResidentStamps: long * 2,
				cacheMaxBytes,
			});

			// Frame 1: the oversized stroke self-evicts from the cache on
			// insert — it must still draw (pooled) and must NOT lease resident
			// store space no cache entry would ever release.
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "big", LONG_LENGTH);
			const frame1 = createPassEncoder();
			context.flushBatch(frame1.passEncoder, "main", transformsBindGroup());
			expect(frame1.draws()).toEqual([
				{ source: POOLED_STAMPS, instanceCount: long, firstInstance: 0 },
			]);
			// The resident stamp store's buffer is created lazily on its first
			// lease — its absence proves the store holds zero live ranges.
			expect(buffers.some((b) => b.label === RESIDENT_STAMPS)).toBe(false);

			// Frame 2: with no capacity residue, a small stroke resident-izes.
			context.beginFrame();
			context.beginBatch();
			addStroke(context, "small", SHORT_LENGTH);
			const frame2 = createPassEncoder();
			context.flushBatch(frame2.passEncoder, "main", transformsBindGroup());
			expect(frame2.draws()).toEqual([
				{ source: RESIDENT_STAMPS, instanceCount: short, firstInstance: 0 },
			]);
		});
	});
});

// Helpers

interface MockBuffer {
	label: string;
	size: number;
	destroy: ReturnType<typeof vi.fn>;
}

interface MockTextureView {
	texture: MockTexture;
	dimension: string;
}

interface MockTexture {
	label: string;
	format: string;
	createView: (desc?: { dimension?: string }) => MockTextureView;
	destroy: ReturnType<typeof vi.fn>;
}

type MockBindingResource = { buffer: MockBuffer } | Record<string, unknown>;

interface MockBindGroup {
	label: string;
	entries: ReadonlyArray<{ binding: number; resource: MockBindingResource }>;
}

interface DecodedDraw {
	/** Label of the stamp buffer bound at binding 1 of bind group 0. */
	source: string;
	instanceCount: number;
	firstInstance: number;
}

const SCATTER: ScatterBrushSettings = {
	type: "scatter",
	source: { kind: "file", fileUid: "test-brush" },
	size: 10,
	sizeByPressure: 0,
	opacity: 1,
	opacityByPressure: 0,
	randomSeed: 1,
	spacing: 0.5,
	flow: 1,
	stampRotation: "none",
	rotationByTilt: 0,
	aspectRatioByTilt: 0,
	sizeBySpeed: 0,
	pooling: 0,
	poolingSizeRatio: 0,
};

/** Multi-source scatter brush: stamps pack random texture-array layer
 *  indices, and draws bind a texture_2d_array. */
const SCATTER_ARRAY: ScatterBrushSettings = {
	...SCATTER,
	scatterSources: [
		{ kind: "file", fileUid: "scatter-1" },
		{ kind: "file", fileUid: "scatter-2" },
	],
};

function createContext(options: {
	maxResidentStamps: number;
	cacheMaxBytes?: number;
}) {
	const buffers: MockBuffer[] = [];
	const writes: Array<{ buffer: MockBuffer; data: Float32Array }> = [];
	const device = {
		createShaderModule: vi.fn(() => ({
			getCompilationInfo: () => Promise.resolve({ messages: [] }),
		})),
		createBindGroupLayout: vi.fn(() => ({})),
		createPipelineLayout: vi.fn(() => ({})),
		createRenderPipeline: vi.fn(() => ({})),
		createSampler: vi.fn(() => ({})),
		createBuffer: vi.fn((desc: { label?: string; size: number }) => {
			const buffer: MockBuffer = {
				label: desc.label ?? "",
				size: desc.size,
				destroy: vi.fn(),
			};
			buffers.push(buffer);
			return buffer;
		}),
		createTexture: vi.fn((desc: { label?: string; format: string }) =>
			createMockTexture(desc.label ?? "", desc.format),
		),
		createCommandEncoder: vi.fn(() => ({
			copyTextureToTexture: vi.fn(),
			finish: vi.fn(() => ({})),
		})),
		createBindGroup: vi.fn(
			(desc: {
				label?: string;
				entries: MockBindGroup["entries"];
			}): MockBindGroup => ({ label: desc.label ?? "", entries: desc.entries }),
		),
		queue: {
			writeTexture: vi.fn(),
			writeBuffer: vi.fn(
				(
					buffer: MockBuffer,
					_bufferOffset: number,
					data: Float32Array | ArrayBuffer,
					dataOffset?: number,
					size?: number,
				) => {
					writes.push({ buffer, data: writtenFloats(data, dataOffset, size) });
				},
			),
			submit: vi.fn(),
		},
	} as unknown as GPUDevice;

	const textures = new Map<string, MockTexture>();
	const textureManager = {
		getTextureAspectRatio: () => 1,
		hasTexture: () => true,
		getTexture: (uid: string) => {
			let texture = textures.get(uid);
			if (!texture) {
				texture = createMockTexture(uid, "rgba8unorm");
				textures.set(uid, texture);
			}
			return texture;
		},
		getTextureSize: () => ({ width: 4, height: 4 }),
		getSampler: () => ({}),
		getMipSampler: () => ({}),
	} as unknown as BrushTextureManager;

	const stampCache = new StampCache(options.cacheMaxBytes);
	const context = new StrokeBatchContext(
		device,
		"bgra8unorm",
		{ label: "uniform" } as unknown as GPUBuffer,
		textureManager,
		{} as unknown as GPUBindGroupLayout,
		() => stampCache,
		{} as unknown as GPUBindGroupLayout,
		() => ({}) as unknown as GPUBindGroup,
		{ maxResidentStamps: options.maxResidentStamps },
	);
	return { context, stampCache, buffers, writes };
}

/** Normalize a queue.writeBuffer payload into the floats actually written:
 *  element offsets for a TypedArray source, byte offsets for an ArrayBuffer
 *  source — mirroring the WebGPU spec. */
function writtenFloats(
	data: Float32Array | ArrayBuffer,
	dataOffset?: number,
	size?: number,
): Float32Array {
	if (data instanceof Float32Array) {
		const start = dataOffset ?? 0;
		return data.slice(start, size === undefined ? undefined : start + size);
	}
	const byteStart = dataOffset ?? 0;
	return new Float32Array(
		data.slice(byteStart, size === undefined ? undefined : byteStart + size),
	);
}

/** A pass-encoder recorder: `draws()` decodes every draw call into the stamp
 *  source bound at the time (resident store vs pooled buffer). */
function createPassEncoder() {
	const ops: Array<
		| { op: "setBindGroup"; index: number; bindGroup: MockBindGroup }
		| { op: "draw"; instanceCount: number; firstInstance: number }
	> = [];
	const passEncoder = {
		setPipeline: vi.fn(),
		setVertexBuffer: vi.fn(),
		setBindGroup: vi.fn((index: number, bindGroup: MockBindGroup) => {
			ops.push({ op: "setBindGroup", index, bindGroup });
		}),
		draw: vi.fn(
			(
				_vertexCount: number,
				instanceCount: number,
				_firstVertex: number,
				firstInstance: number,
			) => {
				ops.push({ op: "draw", instanceCount, firstInstance });
			},
		),
	} as unknown as GPURenderPassEncoder;

	const draws = (): DecodedDraw[] => {
		let source = "unknown";
		const decoded: DecodedDraw[] = [];
		for (const op of ops) {
			if (op.op === "setBindGroup") {
				if (op.index === 0) source = stampSourceOf(op.bindGroup);
				continue;
			}
			decoded.push({
				source,
				instanceCount: op.instanceCount,
				firstInstance: op.firstInstance,
			});
		}
		return decoded;
	};

	/** Bind group 0 active at each draw, in draw order. */
	const drawBindGroup0s = (): MockBindGroup[] => {
		let bindGroup0: MockBindGroup | null = null;
		const result: MockBindGroup[] = [];
		for (const op of ops) {
			if (op.op === "setBindGroup") {
				if (op.index === 0) bindGroup0 = op.bindGroup;
				continue;
			}
			if (!bindGroup0) throw new Error("draw before bind group 0 was set");
			result.push(bindGroup0);
		}
		return result;
	};
	return { passEncoder, draws, drawBindGroup0s };
}

function transformsBindGroup(): GPUBindGroup {
	return { label: "transforms" } as unknown as GPUBindGroup;
}

function stampSourceOf(bindGroup: MockBindGroup): string {
	const resource = bindGroup.entries.find((e) => e.binding === 1)?.resource;
	if (resource && "buffer" in resource) {
		return (resource.buffer as MockBuffer).label;
	}
	return "unknown";
}

function addStroke(
	context: StrokeBatchContext,
	id: string,
	length: number,
	brush: ScatterBrushSettings = SCATTER,
	alphaMultiplier = 1,
) {
	const path = scatterPath(id, length, brush);
	context.addToBatch(path, path.segments, alphaMultiplier);
}

function scatterPath(
	id: string,
	length: number,
	brush: ScatterBrushSettings = SCATTER,
): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [lineSegment(length)],
		filters: [strokeAppearance(brush)],
	};
}

function strokeAppearance(brush: ScatterBrushSettings): StrokeAppearance {
	return {
		uid: "stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				// Gradient stroke color so overflow strokes would hit the stops
				// store too, were they admitted.
				strokeColor: {
					type: "stroke-gradient",
					mode: "along",
					gradient: {
						type: "linear",
						x1: 0,
						y1: 0,
						x2: 1,
						y2: 0,
						stops: [
							{
								offset: 0,
								color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
								midpoint: 0.5,
							},
							{
								offset: 1,
								color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
								midpoint: 0.5,
							},
						],
					},
				},
				brushSettings: brush,
			},
		},
	};
}

function lineSegment(length: number): PathSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: length, y: 0 },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: true,
	};
}

/** Generate stamps for a straight stroke of `length`, using the SAME
 *  normalized settings the context derives. */
function generateFixtureStamps(length: number) {
	const normalized = normalizeBrushSettings(SCATTER);
	if (normalized.type !== "scatter") {
		throw new Error("test fixture must normalize to a scatter brush");
	}
	return generateStampsDirect(
		[lineSegment(length)],
		normalized,
		0,
		0,
		1,
		undefined,
		1,
		0,
		-1,
		-1,
		NIB_SHAPE_CIRCLE,
	);
}

/** Stamp count the context's generator will produce for a straight stroke of
 *  `length` (independent of texture-array variants — they only affect layer
 *  packing). */
function stampCountFor(length: number): number {
	return generateFixtureStamps(length).count;
}

/** Byte length of the generated (possibly over-allocated) stamp array — the
 *  size StampCache budgets a non-resident entry by. */
function generatedDataBytesFor(length: number): number {
	return generateFixtureStamps(length).data.byteLength;
}

function createMockTexture(label: string, format: string): MockTexture {
	const texture: MockTexture = {
		label,
		format,
		createView: (desc?: { dimension?: string }) => ({
			texture,
			dimension: desc?.dimension ?? "2d",
		}),
		destroy: vi.fn(),
	};
	return texture;
}

/** The texture view bound at binding 2 of a stamp draw's bind group 0. */
function textureViewOf(bindGroup: MockBindGroup): MockTextureView {
	const resource = bindGroup.entries.find((e) => e.binding === 2)?.resource;
	if (!isMockTextureView(resource)) {
		throw new Error("bind group 0 has no texture view at binding 2");
	}
	return resource;
}

function isMockTextureView(value: unknown): value is MockTextureView {
	return (
		typeof value === "object" &&
		value !== null &&
		"texture" in value &&
		"dimension" in value
	);
}

/** Whether any stamp's packed pathIndex/layer field (float offset 6) is
 *  non-zero. With pathIndex 0, a non-zero value proves a texture-array layer
 *  was packed. */
function hasNonZeroPackedLayer(stampData: Float32Array): boolean {
	return layersOf(stampData).some((layer) => layer !== 0);
}

/** Per-stamp packed field (float offset 6) bit-cast to u32, in stamp order. */
function packedFieldsOf(stampData: Float32Array): number[] {
	const u32 = new Uint32Array(1);
	const f32 = new Float32Array(u32.buffer);
	const fields: number[] = [];
	for (let off = 6; off < stampData.length; off += 16) {
		f32[0] = stampData[off];
		fields.push(u32[0]);
	}
	return fields;
}

/** Per-stamp meta index (lower 16 bits of the packed field). */
function metaIndicesOf(stampData: Float32Array): number[] {
	return packedFieldsOf(stampData).map((v) => v & 0xffff);
}

/** Per-stamp texture-array layer (upper 16 bits of the packed field). */
function layersOf(stampData: Float32Array): number[] {
	return packedFieldsOf(stampData).map((v) => v >>> 16);
}

function findBuffer(buffers: readonly MockBuffer[], label: string): MockBuffer {
	const buffer = buffers.find((b) => b.label === label);
	if (!buffer) throw new Error(`test setup: buffer "${label}" was not created`);
	return buffer;
}

function countWrites(
	writes: ReadonlyArray<{ buffer: MockBuffer }>,
	buffer: MockBuffer,
): number {
	return writes.filter((w) => w.buffer === buffer).length;
}
