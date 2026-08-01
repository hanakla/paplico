export type MessageType =
	| "WEBGPU_INIT"
	| "WEBGPU_DEVICE_CREATED"
	| "WEBGPU_RESOURCE_CREATED"
	| "WEBGPU_RESOURCE_DESTROYED"
	| "WEBGPU_COMMAND_RECORDED"
	| "WEBGPU_FRAME_BOUNDARY"
	| "WEBGPU_ERROR"
	| "WEBGPU_MEMORY_SNAPSHOT"
	| "WEBGPU_REQUEST_BUFFER_DATA"
	| "WEBGPU_BUFFER_DATA"
	| "WEBGPU_REQUEST_TEXTURE_DATA"
	| "WEBGPU_TEXTURE_DATA"
	| "WEBGPU_SETTINGS_CHANGED"
	| "WEBGPU_PANEL_READY"
	| "WEBGPU_REQUEST_STATE";

export interface DevToolsSettings {
	injectCopySrc: boolean;
	preserveOnReload: boolean;
}

export type ResourceType =
	| "GPUBuffer"
	| "GPUTexture"
	| "GPUTextureView"
	| "GPUSampler"
	| "GPUShaderModule"
	| "GPURenderPipeline"
	| "GPUComputePipeline"
	| "GPUBindGroup"
	| "GPUBindGroupLayout"
	| "GPUPipelineLayout"
	| "GPUCommandEncoder"
	| "GPURenderPassEncoder"
	| "GPUComputePassEncoder"
	| "GPUQuerySet";

export interface ResourceRelation {
	targetId: string;
	targetType: ResourceType;
	role: string;
}

export interface ResourceInfo {
	id: string;
	type: ResourceType;
	label?: string;
	createdAt: number;
	properties: Record<string, unknown>;
	relations?: ResourceRelation[];
	stackTrace?: string;
}

export interface DeviceInfo {
	id: string;
	label?: string;
	adapterInfo: {
		vendor: string;
		architecture: string;
		device: string;
		description: string;
	};
	features: string[];
	limits: Record<string, number>;
}

export interface CommandInfo {
	id: string;
	type: string;
	args: Record<string, unknown>;
	timestamp: number;
	deviceId: string;
}

export interface FrameRelationEntry {
	id: string;
	type: string;
	label?: string;
	relations: ResourceRelation[];
}

export interface FrameInfo {
	frameNumber: number;
	timestamp: number;
	commandCount: number;
	drawCalls: number;
	dispatchCalls: number;
	relations?: FrameRelationEntry[];
}

export interface ErrorInfo {
	id: string;
	type: "validation" | "out-of-memory" | "internal" | "lost";
	message: string;
	timestamp: number;
	deviceId: string;
}

export interface MemorySnapshot {
	timestamp: number;
	totalBytes: number;
	byType: Partial<Record<ResourceType, number>>;
}

export interface BufferDataResponse {
	resourceId: string;
	data: string;
	byteLength: number;
	error?: string;
}

export interface TextureDataResponse {
	resourceId: string;
	data: string;
	width: number;
	height: number;
	error?: string;
}

export interface WebGPUMessage {
	source: "webgpu-devtools";
	type: MessageType;
	payload: unknown;
	tabId?: number;
}

export interface CapturedResource {
	resource: ResourceInfo;
	capturedAt: number;
	destroyed: boolean;
	destroyedAt?: number;
}

export interface CaptureRule {
	id: string;
	enabled: boolean;
	type: "GPUTexture" | "GPUBuffer" | "both";
	minBytes: number;
}

export interface CaptureSettings {
	rules: CaptureRule[];
}

export interface WebGPUState {
	devices: DeviceInfo[];
	resources: ResourceInfo[];
	commands: CommandInfo[];
	frames: FrameInfo[];
	errors: ErrorInfo[];
	memorySnapshots: MemorySnapshot[];
	captures: CapturedResource[];
}
