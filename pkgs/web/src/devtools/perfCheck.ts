import type { Paplico } from "@/core/Paplico";

/**
 * Dev-only render profiler. Patches the WebGPU device / render pipeline of a
 * running Paplico instance, records render passes, draws, GPU timestamps and
 * CPU method timings for `durationMs`, then restores all patches and returns
 * the aggregated result JSON.
 */

export interface PerfCheckResult {
	durationMs: number;
	renders: number;
	fps: number;
	gpuTimingSupported: boolean;
	coverage: Record<string, number> | null;
	context: PerfCheckContext;
	inventory: unknown;
	overall: unknown;
	windows: unknown[];
}

/** Document / viewport / GPU conditions the measurement ran under. */
export interface PerfCheckContext {
	rasterizationDpi: number | null;
	rasterScale: number | null;
	viewportAtStart: unknown;
	viewportAtEnd: unknown;
	canvas: { width: number; height: number; pixelRatio: number } | null;
	devicePixelRatio: number;
	gpuLimits: { maxTextureDimension2D: number };
}

type PassRecord = {
	label: string;
	dims: string;
	draws: number;
	origin: string;
	gpuMs: number | null;
};

type RenderRecord = {
	t: number;
	strategy: string | null;
	passes: PassRecord[];
	copies: string[];
};

type CpuSample = { t: number; method: string; ms: number };
type DirtyEvent = { t: number; reason: string };

type QueryCtx = {
	querySet: GPUQuerySet;
	resolveBuf: GPUBuffer;
	readBuf: GPUBuffer;
	used: number;
	pending: Array<{ passRec: PassRecord; begin: number; end: number }>;
};

let running = false;

export async function runPerfCheck(
	paplico: Paplico,
	durationMs = 10_000,
): Promise<PerfCheckResult | null> {
	if (running) {
		console.warn("[perf] a measurement is already running.");
		return null;
	}

	// Instrumentation needs the facade's private internals; there is no public
	// surface for them and adding one only for profiling is not worth it.
	const p = paplico as any;
	const orchestrator = p.renderer;
	if (!orchestrator) {
		console.error("[perf] paplico.renderer not found.");
		return null;
	}
	const device: GPUDevice | null =
		orchestrator.getDevice?.() ?? orchestrator.device ?? null;
	if (!device) {
		console.error("[perf] GPU device not found.");
		return null;
	}
	const td = orchestrator.targets
		? [...orchestrator.targets.values()][0]
		: null;
	const canvasLayer = td?.canvasLayer;
	const uiLayer = td?.uiLayer;
	const filterRenderer = orchestrator.filterRenderer ?? null;
	const targetEntry = p.canvasTargets ? [...p.canvasTargets.values()][0] : null;
	const scheduler = targetEntry?.scheduler ?? null;
	const canvasTarget = targetEntry?.target ?? null;
	const document_ = p.uiState?.document ?? p.rendererStore?.document ?? null;
	if (!canvasLayer || !uiLayer) {
		console.error("[perf] no active canvas target (canvas must be rendering).");
		return null;
	}

	const gpuTimingSupported = device.features?.has?.("timestamp-query") ?? false;
	const MAX_QUERIES = 512; // timestamp slots per encoder

	// ---- storage -------------------------------------------------------------
	const patches: Array<{ obj: any; key: string; orig: any }> = [];
	const renders: RenderRecord[] = [];
	const cpuSamples: CpuSample[] = [];
	const dirtyEvents: DirtyEvent[] = [];
	let curRender: RenderRecord | null = null;
	let viewportAtStart: unknown = null;
	const state = {
		windowMs: 2_000,
		// Capturing a JS stack per render pass is costly (skews CPU numbers);
		// set false to drop passOriginsPerRender and lighten the profiler.
		captureOrigins: true,
		startedAt: performance.now(),
	};
	const nowRel = () => performance.now() - state.startedAt;

	function patch(
		obj: any,
		key: string,
		factory: (orig: (...args: any[]) => any) => (...args: any[]) => any,
	) {
		if (!obj || typeof obj[key] !== "function") return false;
		const orig = obj[key];
		patches.push({ obj, key, orig });
		obj[key] = factory(orig);
		return true;
	}

	// For throwaway instances (per-frame encoders): wrap without registering a
	// restore entry — the instance is discarded after finish(), so restoring it
	// is pointless and would grow `patches` unbounded during measurement.
	function wrapLocal(
		obj: any,
		key: string,
		factory: (orig: (...args: any[]) => any) => (...args: any[]) => any,
	) {
		if (typeof obj[key] === "function") obj[key] = factory(obj[key]);
	}

	// ---- GPU timestamp query pool (per encoder) ------------------------------
	// coverage mirrors a block-pool: passes we could not time are counted.
	const coverage = {
		measuredPasses: 0,
		totalPasses: 0,
		invalidDurations: 0,
		noFreeBlock: 0,
	};

	function makeQueryCtx(): QueryCtx | null {
		if (!gpuTimingSupported) return null;
		try {
			return {
				querySet: device!.createQuerySet({
					type: "timestamp",
					count: MAX_QUERIES,
				}),
				resolveBuf: device!.createBuffer({
					size: MAX_QUERIES * 8,
					usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
				}),
				readBuf: device!.createBuffer({
					size: MAX_QUERIES * 8,
					usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
				}),
				used: 0,
				pending: [],
			};
		} catch {
			return null;
		}
	}

	function originOf() {
		const stack = new Error().stack ?? "";
		return stack
			.split("\n")
			.slice(3, 8) // drop Error + beginRenderPass wrapper frames
			.map((l) => {
				const m = l.match(/at\s+([^\s(]+)/);
				return m ? m[1] : null;
			})
			.filter(Boolean)
			.join(" < ");
	}

	// Map a GPUTextureView back to its texture so a render pass can read the
	// attachment's label + size (views don't expose them).
	const viewToTex = new WeakMap<GPUTextureView, GPUTexture>();
	patch(
		GPUTexture.prototype,
		"createView",
		(orig) =>
			function (this: GPUTexture, ...a: any[]) {
				const v = orig.apply(this, a);
				try {
					viewToTex.set(v, this);
				} catch {}
				return v;
			},
	);

	function texInfo(view: GPUTextureView | GPUTexture | undefined) {
		const t =
			view instanceof GPUTexture
				? view
				: view
					? viewToTex.get(view)
					: undefined;
		if (!t) return { label: "?", dims: "?" };
		return {
			label: t.label || "(unlabeled)",
			dims: `${t.width}x${t.height}`,
		};
	}

	patch(
		device,
		"createCommandEncoder",
		(orig) =>
			function (this: GPUDevice, ...a: any[]) {
				const encoder = orig.apply(this, a);
				const qctx = makeQueryCtx();

				wrapLocal(
					encoder,
					"beginRenderPass",
					(obp) =>
						function (this: GPUCommandEncoder, desc: GPURenderPassDescriptor) {
							const label = desc?.label || "(unlabeled)";
							const att = [...(desc?.colorAttachments ?? [])][0]?.view;
							const { dims } = texInfo(att);
							const rec: PassRecord = {
								label,
								dims,
								draws: 0,
								origin: state.captureOrigins ? originOf() : "",
								gpuMs: null,
							};
							coverage.totalPasses++;
							if (curRender) curRender.passes.push(rec);

							let useDesc = desc;
							if (
								qctx &&
								!desc?.timestampWrites &&
								qctx.used + 2 <= MAX_QUERIES
							) {
								const begin = qctx.used;
								const end = qctx.used + 1;
								qctx.used += 2;
								qctx.pending.push({ passRec: rec, begin, end });
								useDesc = {
									...desc,
									timestampWrites: {
										querySet: qctx.querySet,
										beginningOfPassWriteIndex: begin,
										endOfPassWriteIndex: end,
									},
								};
							} else if (qctx) {
								coverage.noFreeBlock++;
							}

							const pass: any = obp.call(this, useDesc);
							for (const m of [
								"draw",
								"drawIndexed",
								"drawIndirect",
								"drawIndexedIndirect",
							]) {
								const of = pass[m];
								if (typeof of === "function") {
									pass[m] = function (this: unknown, ...args: any[]) {
										rec.draws++;
										return of.apply(this, args);
									};
								}
							}
							return pass;
						},
				);

				wrapLocal(
					encoder,
					"copyTextureToTexture",
					(octt) =>
						function (
							this: GPUCommandEncoder,
							src: GPUTexelCopyTextureInfo,
							dst: GPUTexelCopyTextureInfo,
							size: GPUExtent3DStrict,
						) {
							try {
								const s = src?.texture;
								const d = dst?.texture;
								const label = `${s?.label || "?"} ${s?.width ?? "?"}x${s?.height ?? "?"} -> ${d?.label || "?"}`;
								if (curRender) curRender.copies.push(label);
							} catch {}
							return octt.call(this, src, dst, size);
						},
				);

				if (qctx) {
					wrapLocal(
						encoder,
						"finish",
						(ofin) =>
							function (this: GPUCommandEncoder, ...args: any[]) {
								if (qctx.used > 0) {
									try {
										this.resolveQuerySet(
											qctx.querySet,
											0,
											qctx.used,
											qctx.resolveBuf,
											0,
										);
										this.copyBufferToBuffer(
											qctx.resolveBuf,
											0,
											qctx.readBuf,
											0,
											qctx.used * 8,
										);
									} catch {}
								}
								const cb = ofin.apply(this, args);
								if (qctx.used > 0) scheduleReadback(qctx);
								else destroyQctx(qctx);
								return cb;
							},
					);
				}

				return encoder;
			},
	);

	function scheduleReadback(qctx: QueryCtx) {
		device!.queue
			.onSubmittedWorkDone()
			.then(() => qctx.readBuf.mapAsync(GPUMapMode.READ))
			.then(() => {
				const ts = new BigInt64Array(qctx.readBuf.getMappedRange());
				for (const { passRec, begin, end } of qctx.pending) {
					const dtNs = ts[end] - ts[begin];
					const ms = Number(dtNs) / 1e6;
					if (dtNs > 0n && Number.isFinite(ms)) {
						passRec.gpuMs = ms;
						coverage.measuredPasses++;
					} else {
						coverage.invalidDurations++;
					}
				}
				qctx.readBuf.unmap();
			})
			.catch(() => {})
			.finally(() => destroyQctx(qctx));
	}

	function destroyQctx(qctx: QueryCtx) {
		try {
			qctx.querySet.destroy();
			qctx.resolveBuf.destroy();
			qctx.readBuf.destroy();
		} catch {}
	}

	// ---- render frame boundary + strategy ------------------------------------
	function reasonToActivity(reasons: Set<string>) {
		if (reasons.has("viewport")) return "pan/zoom";
		if (reasons.has("document") || reasons.has("elementMove")) return "edit";
		if (reasons.has("resize")) return "resize";
		return [...reasons][0] ?? "idle";
	}

	patch(
		Object.getPrototypeOf(orchestrator),
		"render",
		(orig) =>
			function (this: unknown, ...a: any[]) {
				const req = a[0];
				const strategy =
					req && typeof req === "object" && "strategy" in req
						? String(req.strategy)
						: null;
				const rec: RenderRecord = {
					t: nowRel(),
					strategy,
					passes: [],
					copies: [],
				};
				const prev = curRender;
				curRender = rec;
				try {
					return orig.apply(this, a);
				} finally {
					renders.push(rec);
					curRender = prev;
				}
			},
	);

	// ---- CPU per-method timing -----------------------------------------------
	function wrapCpu(proto: any, name: string, label: string) {
		if (!proto) return;
		patch(
			proto,
			name,
			(orig) =>
				function (this: unknown, ...a: any[]) {
					const t0 = performance.now();
					try {
						return orig.apply(this, a);
					} finally {
						cpuSamples.push({
							t: nowRel(),
							method: label,
							ms: performance.now() - t0,
						});
					}
				},
		);
	}
	const clProto = Object.getPrototypeOf(canvasLayer);
	wrapCpu(clProto, "render", "CanvasLayer.render");
	wrapCpu(clProto, "renderDocument", "CanvasLayer.renderDocument");
	wrapCpu(clProto, "executeFrame", "CanvasLayer.executeFrame");
	wrapCpu(clProto, "renderElements", "CanvasLayer.renderElements");
	wrapCpu(Object.getPrototypeOf(uiLayer), "render", "UILayer.render");
	if (filterRenderer)
		wrapCpu(
			Object.getPrototypeOf(filterRenderer),
			"applyFilters",
			"FilterRenderer.applyFilters",
		);

	// ---- markDirty reasons ---------------------------------------------------
	if (scheduler) {
		patch(
			Object.getPrototypeOf(scheduler),
			"markDirty",
			(orig) =>
				function (this: unknown, reason: unknown, ...rest: any[]) {
					dirtyEvents.push({ t: nowRel(), reason: String(reason) });
					return orig.call(this, reason, ...rest);
				},
		);
	}

	// ---- reporting -----------------------------------------------------------
	const pct = (arr: number[], q: number) => {
		if (!arr.length) return 0;
		const s = [...arr].sort((x, y) => x - y);
		return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(3);
	};
	const stat = (arr: number[]) =>
		arr.length
			? {
					calls: arr.length,
					totalMs: +arr.reduce((a, b) => a + b, 0).toFixed(1),
					avgMs: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3),
					p50Ms: pct(arr, 0.5),
					p95Ms: pct(arr, 0.95),
					maxMs: +Math.max(...arr).toFixed(3),
				}
			: null;

	function aggregate(renderSet: RenderRecord[], cpuSet: CpuSample[]) {
		const rc = renderSet.length || 1;
		const passCount: Record<string, number> = {};
		const passDraws: Record<string, number> = {};
		const passEmpty: Record<string, number> = {};
		const passDims: Record<string, Record<string, number>> = {};
		const passOrigin: Record<string, number> = {};
		const gpuByLabel: Record<string, number[]> = {};
		const copyCount: Record<string, number> = {};

		for (const r of renderSet) {
			for (const ps of r.passes) {
				passCount[ps.label] = (passCount[ps.label] ?? 0) + 1;
				passDraws[ps.label] = (passDraws[ps.label] ?? 0) + ps.draws;
				if (ps.draws === 0)
					passEmpty[ps.label] = (passEmpty[ps.label] ?? 0) + 1;
				passDims[ps.label] ??= {};
				passDims[ps.label][ps.dims] = (passDims[ps.label][ps.dims] ?? 0) + 1;
				const ok = `${ps.label} | ${ps.origin}`;
				passOrigin[ok] = (passOrigin[ok] ?? 0) + 1;
				if (ps.gpuMs != null) {
					gpuByLabel[ps.label] ??= [];
					gpuByLabel[ps.label].push(ps.gpuMs);
				}
			}
			for (const c of r.copies) copyCount[c] = (copyCount[c] ?? 0) + 1;
		}

		const cpuByMethod: Record<string, number[]> = {};
		for (const s of cpuSet) {
			cpuByMethod[s.method] ??= [];
			cpuByMethod[s.method].push(s.ms);
		}

		const round = (o: Record<string, number>, f: (v: number) => number) =>
			Object.fromEntries(
				Object.entries(o)
					.map(([k, v]) => [k, +f(v).toFixed(2)] as [string, number])
					.sort((x, y) => y[1] - x[1]),
			);

		const gpu: Record<string, NonNullable<ReturnType<typeof stat>>> = {};
		for (const [k, arr] of Object.entries(gpuByLabel)) {
			const s = stat(arr);
			if (s) gpu[k] = s;
		}
		const cpu: Record<
			string,
			NonNullable<ReturnType<typeof stat>> & { callsPerRender: number }
		> = {};
		for (const [k, arr] of Object.entries(cpuByMethod)) {
			const s = stat(arr);
			if (s) cpu[k] = { ...s, callsPerRender: +(arr.length / rc).toFixed(2) };
		}

		const topGpu = Object.entries(gpu)
			.sort((a, b) => b[1].totalMs - a[1].totalMs)
			.slice(0, 6)
			.map(([k, v]) => `${k} ${v.totalMs}ms x${(v.calls / rc).toFixed(1)}/r`)
			.join("  |  ");
		const topCpu = Object.entries(cpu)
			.sort((a, b) => b[1].totalMs - a[1].totalMs)
			.slice(0, 6)
			.map(([k, v]) => `${k} ${v.totalMs}ms x${v.callsPerRender}/r`)
			.join("  |  ");

		return {
			passesPerRender: round(passCount, (v) => v / rc),
			drawsPerRender: round(passDraws, (v) => v / rc),
			emptyPassesPerRender: round(passEmpty, (v) => v / rc),
			copiesPerRender: round(copyCount, (v) => v / rc),
			passOriginsPerRender: round(passOrigin, (v) => v / rc),
			passDims,
			gpuPassMsSumPerRender: +(
				Object.values(gpu).reduce((a, v) => a + v.totalMs, 0) / rc
			).toFixed(1),
			topGpu,
			topCpu,
			gpu,
			cpu,
		};
	}

	const snapshotViewport = (): unknown =>
		typeof canvasTarget?.getViewport === "function"
			? { ...canvasTarget.getViewport() }
			: null;

	function buildContext(): PerfCheckContext {
		const rasterizationDpi = document_?.rasterizationDpi ?? null;
		return {
			rasterizationDpi,
			rasterScale: rasterizationDpi != null ? rasterizationDpi / 72 : null,
			viewportAtStart,
			viewportAtEnd: snapshotViewport(),
			canvas: canvasTarget
				? {
						width: canvasTarget.width,
						height: canvasTarget.height,
						pixelRatio: canvasTarget.pixelRatio,
					}
				: null,
			devicePixelRatio: globalThis.devicePixelRatio ?? 1,
			gpuLimits: {
				maxTextureDimension2D: device!.limits.maxTextureDimension2D,
			},
		};
	}

	function buildInventory() {
		if (!document_) return null;
		const objects = document_.objects ?? {};
		let extrudes = 0;
		let glass = 0;
		let dropShadows = 0;
		for (const el of Object.values<any>(objects)) {
			for (const f of el?.filters ?? []) {
				const proc = f?.filter?.processor ?? f?.processor;
				if (proc === "extrude3d" || proc === "revolve3d") {
					extrudes++;
					if (f?.filter?.settings?.isGlass ?? f?.settings?.isGlass) glass++;
				}
				if (proc === "drop-shadow") dropShadows++;
			}
		}
		return {
			artboards: (document_.artboards ?? []).map((a: any) => ({
				id: a.id,
				name: a.name,
				w: a.width,
				h: a.height,
			})),
			counts: {
				objects: Object.keys(objects).length,
				extrudes,
				glass,
				dropShadows,
			},
		};
	}

	function buildWindows() {
		const total = nowRel();
		const nWin = Math.max(1, Math.ceil(total / state.windowMs));
		const out: Array<
			ReturnType<typeof aggregate> & {
				window: number;
				activity: string;
				renders: number;
				renderFps: number;
			}
		> = [];
		for (let i = 0; i < nWin; i++) {
			const lo = i * state.windowMs;
			const hi = lo + state.windowMs;
			const rSet = renders.filter((r) => r.t >= lo && r.t < hi);
			if (!rSet.length) continue;
			const cSet = cpuSamples.filter((s) => s.t >= lo && s.t < hi);
			const reasons = new Set(
				dirtyEvents.filter((d) => d.t >= lo && d.t < hi).map((d) => d.reason),
			);
			const secs = Math.min(state.windowMs, total - lo) / 1000;
			out.push({
				window: i,
				activity: reasonToActivity(reasons),
				renders: rSet.length,
				renderFps: +(rSet.length / secs).toFixed(1),
				...aggregate(rSet, cSet),
			});
		}
		return out;
	}

	function buildResult(): PerfCheckResult {
		const total = nowRel();
		return {
			durationMs: +total.toFixed(1),
			renders: renders.length,
			fps: +(renders.length / (total / 1000)).toFixed(1),
			gpuTimingSupported,
			coverage: gpuTimingSupported
				? {
						...coverage,
						percent: coverage.totalPasses
							? +(
									(coverage.measuredPasses / coverage.totalPasses) *
									100
								).toFixed(1)
							: 0,
					}
				: null,
			context: buildContext(),
			inventory: buildInventory(),
			overall: aggregate(renders, cpuSamples),
			windows: buildWindows(),
		};
	}

	function stop() {
		for (const { obj, key, orig } of patches) obj[key] = orig;
		patches.length = 0;
		console.log("[perf] patches removed.");
	}

	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

	running = true;
	viewportAtStart = snapshotViewport();
	try {
		console.log(
			`%c[perf] measuring ${(durationMs / 1000).toFixed(0)}s (gpuTiming=${gpuTimingSupported}) — interact now...`,
			"color:#0a0;font-weight:bold",
		);
		await sleep(durationMs);
		console.log("[perf] window ended.");
		// wait a beat so the last frames' async GPU readbacks resolve
		await sleep(200);
		const result = buildResult();
		console.log("[perf] result JSON:");
		console.log(JSON.stringify(result, null, 2));
		return result;
	} finally {
		stop();
		running = false;
	}
}
