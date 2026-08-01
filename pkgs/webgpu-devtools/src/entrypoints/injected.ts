// WebGPU API interceptor — runs in page context (MAIN world) via injectScript
export default defineUnlistedScript(() => {
	if (!navigator.gpu) return;

	let injectCopySrc = false;

	const POST = (type: string, payload: unknown) =>
		window.postMessage({ source: "webgpu-devtools", type, payload }, "*");

	let idCounter = 0;
	const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

	const resourceMap = new WeakMap<object, string>();
	const liveResources = new Map<
		string,
		{ ref: WeakRef<object>; deviceId: string }
	>();
	const devices = new Map<string, GPUDevice>();
	const resourceCreationInfo = new Map<
		string,
		{
			type: string;
			label?: string;
			relations: { targetId: string; targetType: string; role: string }[];
		}
	>();
	const resourceSizes = new Map<string, { type: string; bytes: number }>();
	let memoryTotalBytes = 0;
	const memoryByType: Record<string, number> = {};
	let memoryDirty = false;
	let memoryTimerId: ReturnType<typeof setTimeout> | null = null;
	let frameNumber = 0;
	let frameDrawCalls = 0;
	let frameDispatchCalls = 0;
	let frameCommandCount = 0;
	let frameUsedResourceIds = new Set<string>();

	function trackResourceSize(id: string, type: string, bytes: number) {
		resourceSizes.set(id, { type, bytes });
		memoryTotalBytes += bytes;
		memoryByType[type] = (memoryByType[type] ?? 0) + bytes;
		scheduleMemorySnapshot();
	}

	function untrackResourceSize(id: string) {
		const entry = resourceSizes.get(id);
		if (!entry) return;
		resourceSizes.delete(id);
		memoryTotalBytes -= entry.bytes;
		memoryByType[entry.type] = (memoryByType[entry.type] ?? 0) - entry.bytes;
		if ((memoryByType[entry.type] ?? 0) <= 0) delete memoryByType[entry.type];
		scheduleMemorySnapshot();
	}

	function scheduleMemorySnapshot() {
		memoryDirty = true;
		if (memoryTimerId != null) return;
		memoryTimerId = setTimeout(flushMemorySnapshot, 50);
	}

	function flushMemorySnapshot() {
		memoryTimerId = null;
		if (!memoryDirty) return;
		memoryDirty = false;
		POST("WEBGPU_MEMORY_SNAPSHOT", {
			timestamp: performance.now(),
			totalBytes: memoryTotalBytes,
			byType: { ...memoryByType },
		});
	}

	// Periodic liveness check — detect GC'd resources
	setInterval(() => {
		for (const [id, entry] of liveResources) {
			if (entry.ref.deref()) continue;
			liveResources.delete(id);
			resourceCreationInfo.delete(id);
			untrackResourceSize(id);
			POST("WEBGPU_RESOURCE_DESTROYED", { id });
		}
	}, 200);

	function estimateTextureBytes(desc: Record<string, unknown>): number {
		const size = desc.size as
			| { width: number; height: number; depthOrArrayLayers?: number }
			| number[]
			| undefined;
		let w = 1;
		let h = 1;
		let d = 1;
		if (Array.isArray(size)) {
			w = size[0] ?? 1;
			h = size[1] ?? 1;
			d = size[2] ?? 1;
		} else if (size) {
			w = size.width;
			h = size.height;
			d = size.depthOrArrayLayers ?? 1;
		}
		const mips = (desc.mipLevelCount as number) ?? 1;
		const samples = (desc.sampleCount as number) ?? 1;
		const bpp = formatBytesPerPixel(desc.format as string);
		return w * h * d * bpp * samples * mips;
	}

	function formatBytesPerPixel(format?: string): number {
		if (!format) return 4;
		if (format.includes("32float"))
			return format.startsWith("rgba") ? 16 : format.startsWith("rg") ? 8 : 4;
		if (format.includes("16float"))
			return format.startsWith("rgba") ? 8 : format.startsWith("rg") ? 4 : 2;
		if (
			format.includes("8unorm") ||
			format.includes("8snorm") ||
			format.includes("8uint") ||
			format.includes("8sint")
		)
			return format.startsWith("rgba") ? 4 : format.startsWith("rg") ? 2 : 1;
		if (format.includes("depth32")) return 4;
		if (format.includes("depth24")) return 4;
		if (format.includes("depth16")) return 2;
		if (format.includes("stencil8")) return 1;
		return 4;
	}

	// Track frame boundaries
	const origRAF = window.requestAnimationFrame.bind(window);
	window.requestAnimationFrame = (cb: FrameRequestCallback) => {
		return origRAF((time) => {
			frameNumber++;
			// Collect relations for resources used this frame
			const frameRelations: {
				id: string;
				type: string;
				label?: string;
				relations: { targetId: string; targetType: string; role: string }[];
			}[] = [];
			for (const id of frameUsedResourceIds) {
				const entry = liveResources.get(id);
				const res = entry?.ref.deref();
				if (!res) continue;
				const resId = resourceMap.get(res);
				if (!resId) continue;
				// Find resource info from creation data
				const info = resourceCreationInfo.get(id);
				if (info?.relations && info.relations.length > 0) {
					frameRelations.push({
						id,
						type: info.type,
						label: info.label,
						relations: info.relations,
					});
				}
			}
			POST("WEBGPU_FRAME_BOUNDARY", {
				frameNumber,
				timestamp: time,
				drawCalls: frameDrawCalls,
				dispatchCalls: frameDispatchCalls,
				commandCount: frameCommandCount,
				relations: frameRelations,
			});
			frameDrawCalls = 0;
			frameDispatchCalls = 0;
			frameCommandCount = 0;
			frameUsedResourceIds = new Set();
			cb(time);
		});
	};

	// Wrap requestAdapter
	const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
	navigator.gpu.requestAdapter = async (options?: GPURequestAdapterOptions) => {
		const adapter = await origRequestAdapter(options);
		if (!adapter) return adapter;

		POST("WEBGPU_INIT", { hasAdapter: true });

		const origRequestDevice = adapter.requestDevice.bind(adapter);
		adapter.requestDevice = async (descriptor?: GPUDeviceDescriptor) => {
			const device = await origRequestDevice(descriptor);
			const deviceId = nextId("device");
			resourceMap.set(device, deviceId);
			devices.set(deviceId, device);

			const info = adapter.info;
			POST("WEBGPU_DEVICE_CREATED", {
				id: deviceId,
				label: descriptor?.label,
				adapterInfo: {
					vendor: info.vendor,
					architecture: info.architecture,
					device: info.device,
					description: info.description,
				},
				features: [...device.features],
				limits: extractLimits(device.limits),
			});

			device.lost.then((lostInfo) => {
				POST("WEBGPU_ERROR", {
					id: nextId("err"),
					type: "lost",
					message: lostInfo.message,
					timestamp: performance.now(),
					deviceId,
				});
			});

			device.addEventListener("uncapturederror", (event) => {
				const err = (event as GPUUncapturedErrorEvent).error;
				let errType: string = "internal";
				if (err instanceof GPUValidationError) errType = "validation";
				else if (err instanceof GPUOutOfMemoryError) errType = "out-of-memory";

				POST("WEBGPU_ERROR", {
					id: nextId("err"),
					type: errType,
					message: err.message,
					timestamp: performance.now(),
					deviceId,
				});
			});

			wrapDevice(device, deviceId);
			return device;
		};

		return adapter;
	};

	function wrapDevice(device: GPUDevice, deviceId: string) {
		const wrapCreator = <T extends object>(
			methodName: string,
			resourceType: string,
		) => {
			const orig = (device as never)[methodName] as (
				desc: GPUObjectDescriptorBase & Record<string, unknown>,
			) => T;
			if (!orig) return;

			(device as never)[methodName] = ((
				descriptor: GPUObjectDescriptorBase & Record<string, unknown>,
			) => {
				if (injectCopySrc && descriptor?.usage != null) {
					const usage = descriptor.usage as number;
					if (resourceType === "GPUTexture") {
						descriptor = {
							...descriptor,
							usage: usage | GPUTextureUsage.COPY_SRC,
						};
					} else if (
						resourceType === "GPUBuffer" &&
						!(usage & GPUBufferUsage.MAP_READ)
					) {
						descriptor = {
							...descriptor,
							usage: usage | GPUBufferUsage.COPY_SRC,
						};
					}
				}
				const result = orig.call(device, descriptor);
				const resId = nextId(resourceType.toLowerCase());
				resourceMap.set(result, resId);
				liveResources.set(resId, { ref: new WeakRef(result), deviceId });

				let bytes = 0;
				if (resourceType === "GPUBuffer") {
					bytes = (descriptor?.size as number) ?? 0;
				} else if (resourceType === "GPUTexture") {
					bytes = estimateTextureBytes(descriptor ?? {});
				}
				if (bytes > 0) {
					trackResourceSize(resId, resourceType, bytes);
				}

				const relations = extractRelations(descriptor, resourceType);
				resourceCreationInfo.set(resId, {
					type: resourceType,
					label: descriptor?.label as string | undefined,
					relations,
				});

				POST("WEBGPU_RESOURCE_CREATED", {
					id: resId,
					type: resourceType,
					label: descriptor?.label,
					createdAt: performance.now(),
					properties: {
						...sanitizeDescriptor(descriptor, resourceType),
						...(bytes > 0 ? { estimatedBytes: bytes } : {}),
					},
					...(relations.length > 0 ? { relations } : {}),
				});

				return result;
			}) as never;
		};

		wrapCreator("createBuffer", "GPUBuffer");
		wrapCreator("createTexture", "GPUTexture");
		wrapCreator("createSampler", "GPUSampler");
		wrapCreator("createBindGroup", "GPUBindGroup");
		wrapCreator("createBindGroupLayout", "GPUBindGroupLayout");
		wrapCreator("createPipelineLayout", "GPUPipelineLayout");
		wrapCreator("createRenderPipeline", "GPURenderPipeline");
		wrapCreator("createComputePipeline", "GPUComputePipeline");
		wrapCreator("createQuerySet", "GPUQuerySet");

		// Shader modules need source code capture
		const origCreateShader = device.createShaderModule.bind(device);
		device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
			const module = origCreateShader(descriptor);
			const resId = nextId("gpushadermodule");
			resourceMap.set(module, resId);
			liveResources.set(resId, { ref: new WeakRef(module), deviceId });

			POST("WEBGPU_RESOURCE_CREATED", {
				id: resId,
				type: "GPUShaderModule",
				label: descriptor.label,
				createdAt: performance.now(),
				properties: { code: descriptor.code },
			});

			return module;
		};

		// Wrap createCommandEncoder
		const origCreateEncoder = device.createCommandEncoder.bind(device);
		device.createCommandEncoder = (
			descriptor?: GPUCommandEncoderDescriptor,
		) => {
			const encoder = origCreateEncoder(descriptor);
			const encoderId = nextId("encoder");
			resourceMap.set(encoder, encoderId);

			wrapCommandEncoder(encoder, encoderId, deviceId);
			return encoder;
		};

		// Wrap buffer destroy
		const origBufferDestroy = GPUBuffer.prototype.destroy;
		GPUBuffer.prototype.destroy = function () {
			const resId = resourceMap.get(this);
			if (resId) {
				untrackResourceSize(resId);
				liveResources.delete(resId);
				resourceCreationInfo.delete(resId);
				POST("WEBGPU_RESOURCE_DESTROYED", {
					id: resId,
					type: "GPUBuffer",
				});
			}
			return origBufferDestroy.call(this);
		};

		const origTextureDestroy = GPUTexture.prototype.destroy;
		GPUTexture.prototype.destroy = function () {
			const resId = resourceMap.get(this);
			if (resId) {
				untrackResourceSize(resId);
				liveResources.delete(resId);
				resourceCreationInfo.delete(resId);
				POST("WEBGPU_RESOURCE_DESTROYED", {
					id: resId,
					type: "GPUTexture",
				});
			}
			return origTextureDestroy.call(this);
		};
	}

	function wrapCommandEncoder(
		encoder: GPUCommandEncoder,
		_encoderId: string,
		deviceId: string,
	) {
		let commandCount = 0;
		let drawCalls = 0;
		let dispatchCalls = 0;

		const origBeginRenderPass = encoder.beginRenderPass.bind(encoder);
		encoder.beginRenderPass = (descriptor: GPURenderPassDescriptor) => {
			const pass = origBeginRenderPass(descriptor);

			POST("WEBGPU_COMMAND_RECORDED", {
				id: nextId("cmd"),
				type: "beginRenderPass",
				args: { colorAttachments: descriptor.colorAttachments.length },
				timestamp: performance.now(),
				deviceId,
			});
			commandCount++;
			frameCommandCount++;

			for (const method of [
				"draw",
				"drawIndexed",
				"drawIndirect",
				"drawIndexedIndirect",
			] as const) {
				const orig = pass[method].bind(pass);
				(pass as never)[method] = ((...args: unknown[]) => {
					drawCalls++;
					commandCount++;
					frameDrawCalls++;
					frameCommandCount++;
					POST("WEBGPU_COMMAND_RECORDED", {
						id: nextId("cmd"),
						type: method,
						args: { vertexCount: args[0] },
						timestamp: performance.now(),
						deviceId,
					});
					return (orig as (...a: never[]) => unknown)(...args);
				}) as never;
			}

			// Track resource usage for relations
			const origSetPipeline = pass.setPipeline.bind(pass);
			pass.setPipeline = (pipeline: GPURenderPipeline) => {
				const pid = resourceMap.get(pipeline);
				if (pid) frameUsedResourceIds.add(pid);
				return origSetPipeline(pipeline);
			};
			const origSetBindGroup = pass.setBindGroup.bind(pass);
			(pass as never).setBindGroup = (
				index: number,
				bindGroup: GPUBindGroup | null,
				...rest: unknown[]
			) => {
				if (bindGroup) {
					const bid = resourceMap.get(bindGroup);
					if (bid) frameUsedResourceIds.add(bid);
				}
				return (origSetBindGroup as (...a: never[]) => unknown)(
					index,
					bindGroup,
					...rest,
				);
			};

			const origEnd = pass.end.bind(pass);
			pass.end = () => {
				POST("WEBGPU_COMMAND_RECORDED", {
					id: nextId("cmd"),
					type: "endRenderPass",
					args: { drawCalls },
					timestamp: performance.now(),
					deviceId,
				});
				return origEnd();
			};

			return pass;
		};

		const origBeginComputePass = encoder.beginComputePass.bind(encoder);
		encoder.beginComputePass = (descriptor?: GPUComputePassDescriptor) => {
			const pass = origBeginComputePass(descriptor);

			POST("WEBGPU_COMMAND_RECORDED", {
				id: nextId("cmd"),
				type: "beginComputePass",
				args: {},
				timestamp: performance.now(),
				deviceId,
			});
			commandCount++;
			frameCommandCount++;

			for (const method of [
				"dispatchWorkgroups",
				"dispatchWorkgroupsIndirect",
			] as const) {
				const orig = pass[method].bind(pass);
				(pass as never)[method] = ((...args: unknown[]) => {
					dispatchCalls++;
					commandCount++;
					frameDispatchCalls++;
					frameCommandCount++;
					POST("WEBGPU_COMMAND_RECORDED", {
						id: nextId("cmd"),
						type: method,
						args: { x: args[0], y: args[1], z: args[2] },
						timestamp: performance.now(),
						deviceId,
					});
					return (orig as (...a: never[]) => unknown)(...args);
				}) as never;
			}

			// Track resource usage for relations
			const origCSetPipeline = pass.setPipeline.bind(pass);
			pass.setPipeline = (pipeline: GPUComputePipeline) => {
				const pid = resourceMap.get(pipeline);
				if (pid) frameUsedResourceIds.add(pid);
				return origCSetPipeline(pipeline);
			};
			const origCSetBindGroup = pass.setBindGroup.bind(pass);
			(pass as never).setBindGroup = (
				index: number,
				bindGroup: GPUBindGroup | null,
				...rest: unknown[]
			) => {
				if (bindGroup) {
					const bid = resourceMap.get(bindGroup);
					if (bid) frameUsedResourceIds.add(bid);
				}
				return (origCSetBindGroup as (...a: never[]) => unknown)(
					index,
					bindGroup,
					...rest,
				);
			};

			return pass;
		};

		for (const method of [
			"copyBufferToBuffer",
			"copyBufferToTexture",
			"copyTextureToBuffer",
			"copyTextureToTexture",
		] as const) {
			const orig = encoder[method].bind(encoder);
			(encoder as never)[method] = ((...args: unknown[]) => {
				commandCount++;
				frameCommandCount++;
				POST("WEBGPU_COMMAND_RECORDED", {
					id: nextId("cmd"),
					type: method,
					args: {},
					timestamp: performance.now(),
					deviceId,
				});
				return (orig as (...a: never[]) => unknown)(...args);
			}) as never;
		}

		const origFinish = encoder.finish.bind(encoder);
		encoder.finish = (descriptor?: GPUCommandBufferDescriptor) => {
			POST("WEBGPU_COMMAND_RECORDED", {
				id: nextId("cmd"),
				type: "finish",
				args: { commandCount, drawCalls, dispatchCalls },
				timestamp: performance.now(),
				deviceId,
			});
			return origFinish(descriptor);
		};
	}

	function extractLimits(limits: GPUSupportedLimits): Record<string, number> {
		const result: Record<string, number> = {};
		for (const key of Object.getOwnPropertyNames(
			Object.getPrototypeOf(limits),
		)) {
			const val = (limits as never)[key];
			if (typeof val === "number") result[key] = val;
		}
		return result;
	}

	function extractRelations(
		desc: Record<string, unknown> | undefined,
		type: string,
	): { targetId: string; targetType: string; role: string }[] {
		if (!desc) return [];
		const relations: { targetId: string; targetType: string; role: string }[] =
			[];

		const resolveId = (obj: unknown) =>
			obj && typeof obj === "object" ? resourceMap.get(obj) : undefined;

		switch (type) {
			case "GPUBindGroup": {
				const layout = resolveId(desc.layout);
				if (layout)
					relations.push({
						targetId: layout,
						targetType: "GPUBindGroupLayout",
						role: "layout",
					});
				const entries = desc.entries as { resource: unknown }[] | undefined;
				if (entries) {
					for (const entry of entries) {
						const res = entry.resource;
						if (res && typeof res === "object") {
							// Could be GPUBufferBinding { buffer }, GPUSampler, or GPUTextureView
							const bufBinding = res as { buffer?: unknown };
							if (bufBinding.buffer) {
								const bufId = resolveId(bufBinding.buffer);
								if (bufId)
									relations.push({
										targetId: bufId,
										targetType: "GPUBuffer",
										role: "binding",
									});
							} else {
								const directId = resolveId(res);
								if (directId) {
									const directType =
										res instanceof GPUTextureView
											? "GPUTextureView"
											: res instanceof GPUSampler
												? "GPUSampler"
												: "unknown";
									relations.push({
										targetId: directId,
										targetType: directType,
										role: "binding",
									});
								}
							}
						}
					}
				}
				break;
			}
			case "GPURenderPipeline": {
				const vertex = desc.vertex as Record<string, unknown> | undefined;
				if (vertex?.module) {
					const id = resolveId(vertex.module);
					if (id)
						relations.push({
							targetId: id,
							targetType: "GPUShaderModule",
							role: "vertex",
						});
				}
				const fragment = desc.fragment as Record<string, unknown> | undefined;
				if (fragment?.module) {
					const id = resolveId(fragment.module);
					if (id)
						relations.push({
							targetId: id,
							targetType: "GPUShaderModule",
							role: "fragment",
						});
				}
				const layout = resolveId(desc.layout);
				if (layout)
					relations.push({
						targetId: layout,
						targetType: "GPUPipelineLayout",
						role: "layout",
					});
				break;
			}
			case "GPUComputePipeline": {
				const compute = desc.compute as Record<string, unknown> | undefined;
				if (compute?.module) {
					const id = resolveId(compute.module);
					if (id)
						relations.push({
							targetId: id,
							targetType: "GPUShaderModule",
							role: "compute",
						});
				}
				const layout = resolveId(desc.layout);
				if (layout)
					relations.push({
						targetId: layout,
						targetType: "GPUPipelineLayout",
						role: "layout",
					});
				break;
			}
			case "GPUPipelineLayout": {
				const layouts = desc.bindGroupLayouts as unknown[] | undefined;
				if (layouts) {
					for (const l of layouts) {
						const id = resolveId(l);
						if (id)
							relations.push({
								targetId: id,
								targetType: "GPUBindGroupLayout",
								role: "bindGroupLayout",
							});
					}
				}
				break;
			}
		}

		return relations;
	}

	function sanitizeDescriptor(
		desc: Record<string, unknown> | undefined,
		type: string,
	): Record<string, unknown> {
		if (!desc) return {};

		switch (type) {
			case "GPUBuffer":
				return {
					size: desc.size,
					usage: desc.usage,
					mappedAtCreation: desc.mappedAtCreation,
				};
			case "GPUTexture": {
				const sz = desc.size as
					| [number, number, number?]
					| { width: number; height?: number; depthOrArrayLayers?: number }
					| undefined;
				const width = Array.isArray(sz) ? sz[0] : (sz?.width ?? 0);
				const height = Array.isArray(sz) ? (sz[1] ?? 1) : (sz?.height ?? 1);
				const depth = Array.isArray(sz)
					? (sz[2] ?? 1)
					: (sz?.depthOrArrayLayers ?? 1);
				return {
					width,
					height,
					depthOrArrayLayers: depth,
					format: desc.format,
					usage: desc.usage,
					dimension: desc.dimension ?? "2d",
					mipLevelCount: desc.mipLevelCount ?? 1,
					sampleCount: desc.sampleCount ?? 1,
				};
			}
			case "GPURenderPipeline":
				return {
					vertex: desc.vertex
						? {
								module: "ref",
								entryPoint: (desc.vertex as Record<string, unknown>).entryPoint,
							}
						: undefined,
					fragment: desc.fragment
						? {
								module: "ref",
								entryPoint: (desc.fragment as Record<string, unknown>)
									.entryPoint,
							}
						: undefined,
					primitive: desc.primitive,
				};
			case "GPUComputePipeline":
				return {
					compute: desc.compute
						? {
								module: "ref",
								entryPoint: (desc.compute as Record<string, unknown>)
									.entryPoint,
							}
						: undefined,
				};
			default:
				return { label: desc.label };
		}
	}

	function arrayBufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = "";
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	async function readBufferData(resourceId: string): Promise<void> {
		const entry = liveResources.get(resourceId);
		const obj = entry?.ref.deref();
		if (!entry || !obj) {
			POST("WEBGPU_BUFFER_DATA", {
				resourceId,
				data: "",
				byteLength: 0,
				error: "Resource not found or destroyed",
			});
			return;
		}

		const buf = obj as GPUBuffer;
		const device = devices.get(entry.deviceId);
		if (!device) {
			POST("WEBGPU_BUFFER_DATA", {
				resourceId,
				data: "",
				byteLength: 0,
				error: "Device not found",
			});
			return;
		}

		try {
			const maxRead = buf.size;
			const staging = device.createBuffer({
				size: maxRead,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			});

			const encoder = device.createCommandEncoder();
			encoder.copyBufferToBuffer(buf, 0, staging, 0, maxRead);
			device.queue.submit([encoder.finish()]);

			await staging.mapAsync(GPUMapMode.READ);
			const data = arrayBufferToBase64(staging.getMappedRange().slice(0));
			staging.unmap();
			staging.destroy();

			POST("WEBGPU_BUFFER_DATA", { resourceId, data, byteLength: maxRead });
		} catch (e) {
			POST("WEBGPU_BUFFER_DATA", {
				resourceId,
				data: "",
				byteLength: 0,
				error: String(e),
			});
		}
	}

	async function readTextureData(resourceId: string): Promise<void> {
		const entry = liveResources.get(resourceId);
		const obj = entry?.ref.deref();
		if (!entry || !obj) {
			POST("WEBGPU_TEXTURE_DATA", {
				resourceId,
				data: "",
				width: 0,
				height: 0,
				error: "Resource not found or destroyed",
			});
			return;
		}

		const tex = obj as GPUTexture;
		const device = devices.get(entry.deviceId);
		if (!device) {
			POST("WEBGPU_TEXTURE_DATA", {
				resourceId,
				data: "",
				width: 0,
				height: 0,
				error: "Device not found",
			});
			return;
		}

		try {
			const w = tex.width;
			const h = tex.height;
			const bytesPerPixel = 4;
			const bytesPerRow = Math.ceil((w * bytesPerPixel) / 256) * 256;
			const bufferSize = bytesPerRow * h;

			const staging = device.createBuffer({
				size: bufferSize,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			});

			const encoder = device.createCommandEncoder();
			encoder.copyTextureToBuffer(
				{ texture: tex },
				{ buffer: staging, bytesPerRow, rowsPerImage: h },
				{ width: w, height: h },
			);
			device.queue.submit([encoder.finish()]);

			await staging.mapAsync(GPUMapMode.READ);
			const mapped = new Uint8Array(staging.getMappedRange());

			const pixels = new Uint8Array(w * h * bytesPerPixel);
			for (let row = 0; row < h; row++) {
				pixels.set(
					mapped.subarray(
						row * bytesPerRow,
						row * bytesPerRow + w * bytesPerPixel,
					),
					row * w * bytesPerPixel,
				);
			}
			staging.unmap();
			staging.destroy();

			const data = arrayBufferToBase64(pixels.buffer);
			POST("WEBGPU_TEXTURE_DATA", { resourceId, data, width: w, height: h });
		} catch (e) {
			POST("WEBGPU_TEXTURE_DATA", {
				resourceId,
				data: "",
				width: 0,
				height: 0,
				error: String(e),
			});
		}
	}

	// Listen for panel requests
	window.addEventListener("message", (event) => {
		if (event.source !== window) return;
		if (event.data?.source !== "webgpu-devtools") return;

		if (event.data.type === "WEBGPU_REQUEST_BUFFER_DATA") {
			readBufferData(event.data.payload.resourceId);
		} else if (event.data.type === "WEBGPU_REQUEST_TEXTURE_DATA") {
			readTextureData(event.data.payload.resourceId);
		} else if (event.data.type === "WEBGPU_SETTINGS_CHANGED") {
			const settings = event.data.payload;
			if (settings && typeof settings.injectCopySrc === "boolean") {
				injectCopySrc = settings.injectCopySrc;
			}
		}
	});
});
