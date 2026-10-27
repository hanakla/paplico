import {
	LOCATION_U32S,
	type StripBatch,
} from "../../../geometry/strips/stripTypes";
import {
	STRIP_COVERAGE_SHADER,
	STRIP_COVERAGE_WORKGROUP_SIZE,
} from "../../../shaders/stripCoverage.wgsl";
import type { ResidentStrips, StripPage } from "./StripPagePool";
import {
	COVERAGE_BATCH_FIELDS,
	COVERAGE_BATCH_U32S,
	COVERAGE_DISPATCH_FIELDS,
	writeU32Record,
} from "./stripCoverageLayout";

/** Dynamic-offset stride of the per-dispatch uniforms. */
const DISPATCH_STRIDE = 256;
const MAX_WORKGROUPS_PER_DIMENSION = 65_535;

interface CoverageJob {
	batch: StripBatch;
	page: StripPage;
	strips: ResidentStrips;
}

/** A growable GPU buffer, recreated when a frame needs more than it holds. */
interface FrameBuffer {
	buffer: GPUBuffer | null;
	label: string;
	usage: number;
}

/**
 * Integrates the coverage of the strip batches rasterized in one frame.
 *
 * `enqueue` records a batch with its place in a page; `flush` concatenates
 * every queued batch into shared buffers, lists where each one starts in a
 * batch table, and submits one compute pass — backdrop over all bands, then coverage and
 * params per page — ahead of the frame's own command buffer, so the frame's
 * draws read finished alphas.
 */
export class StripCoverage {
	private readonly layout: GPUBindGroupLayout;
	private readonly backdropPipeline: GPUComputePipeline;
	private readonly coveragePipeline: GPUComputePipeline;
	private readonly paramsPipeline: GPUComputePipeline;
	private jobs: CoverageJob[] = [];
	private readonly buffers = {
		dispatch: frameBuffer("Strip Coverage Dispatch", GPUBufferUsage.UNIFORM),
		lines: frameBuffer("Strip Coverage Lines", GPUBufferUsage.STORAGE),
		entries: frameBuffer("Strip Coverage Entries", GPUBufferUsage.STORAGE),
		locations: frameBuffer("Strip Coverage Locations", GPUBufferUsage.STORAGE),
		bands: frameBuffer("Strip Coverage Bands", GPUBufferUsage.STORAGE),
		batches: frameBuffer("Strip Coverage Batches", GPUBufferUsage.STORAGE),
		backdrops: frameBuffer("Strip Coverage Backdrops", GPUBufferUsage.STORAGE),
		triangles: frameBuffer("Strip Coverage Triangles", GPUBufferUsage.STORAGE),
		triEntries: frameBuffer(
			"Strip Coverage Triangle Entries",
			GPUBufferUsage.STORAGE,
		),
	};

	/** @param paramsFallback Bound in place of a page that has no params texture. */
	public constructor(
		private readonly device: GPUDevice,
		private readonly paramsFallback: GPUTextureView,
	) {
		const storage = (
			type: GPUBufferBindingType,
		): GPUBindGroupLayoutEntry["buffer"] => ({ type });
		const entries: GPUBindGroupLayoutEntry[] = [
			{
				binding: 0,
				visibility: GPUShaderStage.COMPUTE,
				buffer: { type: "uniform", hasDynamicOffset: true },
			},
			...[1, 2, 3, 4].map((binding) => ({
				binding,
				visibility: GPUShaderStage.COMPUTE,
				buffer: storage("read-only-storage"),
			})),
			{
				binding: 5,
				visibility: GPUShaderStage.COMPUTE,
				buffer: storage("storage"),
			},
			...[6, 7].map((binding) => ({
				binding,
				visibility: GPUShaderStage.COMPUTE,
				buffer: storage("read-only-storage"),
			})),
			...[8, 9].map((binding) => ({
				binding,
				visibility: GPUShaderStage.COMPUTE,
				storageTexture: {
					access: "write-only" as const,
					format: "rgba8unorm" as const,
				},
			})),
			{
				binding: 10,
				visibility: GPUShaderStage.COMPUTE,
				buffer: storage("read-only-storage"),
			},
		];
		this.layout = device.createBindGroupLayout({
			label: "Strip Coverage Bind Group Layout",
			entries,
		});
		const module = device.createShaderModule({
			label: "Strip Coverage Shader",
			code: STRIP_COVERAGE_SHADER,
		});
		const pipelineLayout = device.createPipelineLayout({
			bindGroupLayouts: [this.layout],
		});
		const pipeline = (entryPoint: string) =>
			device.createComputePipeline({
				label: `Strip Coverage ${entryPoint}`,
				layout: pipelineLayout,
				compute: { module, entryPoint },
			});
		this.backdropPipeline = pipeline("backdrop");
		this.coveragePipeline = pipeline("coverage");
		this.paramsPipeline = pipeline("params");
	}

	/** Queue the coverage of a batch that `strips` placed in a page. */
	public enqueue(batch: StripBatch, strips: ResidentStrips): void {
		if (!strips.page) return;
		this.jobs.push({ batch, page: strips.page, strips });
	}

	/** Drop batches whose frame never reached `flush`; their entries re-rasterize. */
	public discardPending(): void {
		for (const job of this.jobs) job.strips.abandoned = true;
		this.jobs = [];
	}

	/** Submit the coverage of every queued batch. Call before the frame's submit. */
	public flush(): void {
		if (this.jobs.length === 0) return;
		// The pool fills one page at a time within a frame and never returns to
		// a page the frame has left, so the jobs already arrive grouped by page.
		const jobs = this.jobs;
		this.jobs = [];
		const packed = packJobs(jobs);

		const dispatches = [
			{ first: 0, count: packed.bandCount },
			...packed.pages.flatMap((p) => [
				{ first: p.firstLocation, count: p.locationCount },
				{ first: p.firstLocation, count: p.locationCount },
			]),
		].map((d) => ({ ...d, ...workgroupGrid(d.count) }));
		const dispatchData = new Uint32Array(
			(dispatches.length * DISPATCH_STRIDE) / 4,
		);
		for (const [i, d] of dispatches.entries()) {
			writeU32Record(
				dispatchData,
				(i * DISPATCH_STRIDE) / 4,
				COVERAGE_DISPATCH_FIELDS,
				{
					first: d.first,
					count: d.count,
					rowStride: d.x * STRIP_COVERAGE_WORKGROUP_SIZE,
					batchCount: jobs.length,
				},
			);
		}
		const b = this.buffers;
		const dispatch = this.upload(b.dispatch, dispatchData);
		const lines = this.upload(b.lines, packed.lines);
		const entries = this.upload(b.entries, packed.entries);
		const locations = this.upload(b.locations, packed.locations);
		const bands = this.upload(b.bands, packed.bands);
		const batches = this.upload(b.batches, packed.batches);
		const backdrops = this.reserve(b.backdrops, packed.locationCount * 16);
		const triangles = this.upload(b.triangles, packed.triangles);
		const triEntries = this.upload(b.triEntries, packed.triEntries);

		const bindGroup = (page: StripPage) =>
			this.device.createBindGroup({
				label: "Strip Coverage Bind Group",
				layout: this.layout,
				entries: [
					{ binding: 0, resource: { buffer: dispatch, size: 16 } },
					{ binding: 1, resource: { buffer: lines } },
					{ binding: 2, resource: { buffer: entries } },
					{ binding: 3, resource: { buffer: locations } },
					{ binding: 4, resource: { buffer: bands } },
					{ binding: 5, resource: { buffer: backdrops } },
					{ binding: 6, resource: { buffer: triangles } },
					{ binding: 7, resource: { buffer: triEntries } },
					{ binding: 8, resource: page.alphaStorage },
					{
						binding: 9,
						resource: page.paramsStorage ?? this.paramsFallback,
					},
					{ binding: 10, resource: { buffer: batches } },
				],
			});

		const encoder = this.device.createCommandEncoder({
			label: "Strip Coverage Encoder",
		});
		const pass = encoder.beginComputePass({ label: "Strip Coverage Pass" });
		const run = (
			pipeline: GPUComputePipeline,
			group: GPUBindGroup,
			index: number,
		) => {
			const { count, x, y } = dispatches[index];
			if (count === 0) return;
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, group, [index * DISPATCH_STRIDE]);
			pass.dispatchWorkgroups(x, y);
		};
		const groups = packed.pages.map((p) => bindGroup(p.page));
		run(this.backdropPipeline, groups[0], 0);
		for (const [i, p] of packed.pages.entries()) {
			run(this.coveragePipeline, groups[i], 1 + i * 2);
			if (p.hasParams) run(this.paramsPipeline, groups[i], 2 + i * 2);
		}
		pass.end();
		this.device.queue.submit([encoder.finish()]);
	}

	public destroy(): void {
		for (const fb of Object.values(this.buffers)) fb.buffer?.destroy();
	}

	private upload(
		fb: FrameBuffer,
		data: ArrayBufferView<ArrayBuffer>,
	): GPUBuffer {
		const buffer = this.reserve(fb, data.byteLength);
		if (data.byteLength > 0) {
			this.device.queue.writeBuffer(
				buffer,
				0,
				data.buffer,
				data.byteOffset,
				data.byteLength,
			);
		}
		return buffer;
	}

	/** A buffer of at least `bytes`; a smaller one is replaced, which is safe once its last use is submitted. */
	private reserve(fb: FrameBuffer, bytes: number): GPUBuffer {
		const size = Math.max(256, Math.ceil(bytes / 256) * 256);
		if (fb.buffer && fb.buffer.size >= size) return fb.buffer;
		fb.buffer?.destroy();
		fb.buffer = this.device.createBuffer({
			label: fb.label,
			size: Math.max(size, (fb.buffer?.size ?? 0) * 2),
			usage: fb.usage | GPUBufferUsage.COPY_DST,
		});
		return fb.buffer;
	}
}

/**
 * Workgroups of a dispatch over `count` invocations, split into rows when one
 * dimension cannot hold them; the kernels rebuild the index from `rowStride`.
 */
function workgroupGrid(count: number): { x: number; y: number } {
	const groups = Math.ceil(count / STRIP_COVERAGE_WORKGROUP_SIZE);
	const x = Math.min(groups, MAX_WORKGROUPS_PER_DIMENSION);
	return { x, y: Math.ceil(groups / Math.max(x, 1)) };
}

function frameBuffer(label: string, usage: number): FrameBuffer {
	return { buffer: null, label, usage };
}

interface PackedJobs {
	lines: Float32Array<ArrayBuffer>;
	entries: Uint32Array<ArrayBuffer>;
	locations: Uint32Array<ArrayBuffer>;
	locationCount: number;
	bands: Uint32Array<ArrayBuffer>;
	bandCount: number;
	batches: Uint32Array<ArrayBuffer>;
	triangles: Float32Array<ArrayBuffer>;
	triEntries: Uint32Array<ArrayBuffer>;
	pages: {
		page: StripPage;
		firstLocation: number;
		locationCount: number;
		hasParams: boolean;
	}[];
}

/**
 * Concatenate the batches, grouped by page, keeping their batch-local
 * indices, and record each batch's bases in the batch table.
 */
function packJobs(jobs: CoverageJob[]): PackedJobs {
	let lineFloats = 0;
	let entryCount = 0;
	let locationCount = 0;
	let bandCount = 0;
	let triangleFloats = 0;
	let triEntryCount = 0;
	for (const { batch } of jobs) {
		lineFloats += batch.lines.length;
		entryCount += batch.entries.length;
		locationCount += batch.locationCount;
		bandCount += batch.bandCount;
		triangleFloats += batch.params?.triangles.length ?? 0;
		triEntryCount += batch.params?.entries.length ?? 0;
	}
	const packed: PackedJobs = {
		lines: new Float32Array(lineFloats),
		entries: new Uint32Array(entryCount),
		locations: new Uint32Array(locationCount * LOCATION_U32S),
		locationCount,
		bands: new Uint32Array(bandCount * 2),
		bandCount,
		batches: new Uint32Array(jobs.length * COVERAGE_BATCH_U32S),
		triangles: new Float32Array(triangleFloats),
		triEntries: new Uint32Array(triEntryCount),
		pages: [],
	};

	let lineBase = 0;
	let entryBase = 0;
	let locationBase = 0;
	let bandBase = 0;
	let triangleBase = 0;
	let triEntryBase = 0;
	for (const [k, { batch, page, strips }] of jobs.entries()) {
		let group = packed.pages.at(-1);
		if (group?.page !== page) {
			group = {
				page,
				firstLocation: locationBase,
				locationCount: 0,
				hasParams: false,
			};
			packed.pages.push(group);
		}
		group.locationCount += batch.locationCount;
		group.hasParams ||= batch.params !== null;

		writeU32Record(
			packed.batches,
			k * COVERAGE_BATCH_U32S,
			COVERAGE_BATCH_FIELDS,
			{
				firstLocation: locationBase,
				locationEnd: locationBase + batch.locationCount,
				firstBand: bandBase,
				firstSlot: strips.firstSlot,
				lineBase,
				entryBase,
				entryEnd: batch.entries.length,
				triBase: triangleBase,
				triEntryBase,
				triEntryEnd: batch.params?.entries.length ?? 0,
				hasParams: batch.params ? 1 : 0,
			},
		);
		packed.lines.set(batch.lines, lineBase * 4);
		packed.entries.set(batch.entries, entryBase);
		packed.locations.set(batch.locations, locationBase * LOCATION_U32S);
		packed.bands.set(batch.bands, bandBase * 2);
		if (batch.params) {
			packed.triangles.set(batch.params.triangles, triangleBase * 12);
			packed.triEntries.set(batch.params.entries, triEntryBase);
			triangleBase += batch.params.triangles.length / 12;
			triEntryBase += batch.params.entries.length;
		}
		lineBase += batch.lines.length / 4;
		entryBase += batch.entries.length;
		locationBase += batch.locationCount;
		bandBase += batch.bandCount;
	}
	return packed;
}
