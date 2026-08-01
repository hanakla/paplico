import { proxy } from "valtio";
import type {
	CapturedResource,
	CaptureSettings,
	CommandInfo,
	DeviceInfo,
	DevToolsSettings,
	ErrorInfo,
	FrameInfo,
	MemorySnapshot,
	ResourceInfo,
} from "../../types";

export const devtoolsState = proxy({
	devices: [] as DeviceInfo[],
	resources: [] as ResourceInfo[],
	commands: [] as CommandInfo[],
	frames: [] as FrameInfo[],
	errors: [] as ErrorInfo[],
	memorySnapshots: [] as MemorySnapshot[],
	captures: [] as CapturedResource[],

	isConnected: false,
	isRecording: true,
	isCapturePaused: false,

	settings: {
		injectCopySrc: false,
		preserveOnReload: false,
	} as DevToolsSettings,

	captureSettings: {
		rules: [],
	} as CaptureSettings,
});

export function resetState() {
	devtoolsState.devices = [];
	devtoolsState.resources = [];
	devtoolsState.commands = [];
	devtoolsState.frames = [];
	devtoolsState.errors = [];
	devtoolsState.memorySnapshots = [];
	devtoolsState.captures = [];
}

export function addDevice(device: DeviceInfo) {
	devtoolsState.devices.push(device);
}

export function addResource(res: ResourceInfo) {
	devtoolsState.resources.push(res);

	if (devtoolsState.isCapturePaused) return;

	// Capture check
	const bytes = (res.properties.estimatedBytes as number) ?? 0;
	const rules = devtoolsState.captureSettings.rules;
	if (!Array.isArray(rules)) return;
	const matched = rules.some(
		(r) =>
			r.enabled &&
			bytes >= r.minBytes &&
			(r.type === "both" || r.type === res.type),
	);
	if (matched) {
		devtoolsState.captures.push({
			resource: res,
			capturedAt: performance.now(),
			destroyed: false,
		});
	}
}

export function removeResource(id: string) {
	const idx = devtoolsState.resources.findIndex((r) => r.id === id);
	if (idx >= 0) devtoolsState.resources.splice(idx, 1);

	const now = performance.now();
	for (const c of devtoolsState.captures) {
		if (c.resource.id === id) {
			c.destroyed = true;
			c.destroyedAt = now;
		}
	}
}

export function addCommand(cmd: CommandInfo) {
	if (devtoolsState.commands.length > 999) {
		devtoolsState.commands.splice(0, devtoolsState.commands.length - 999);
	}
	devtoolsState.commands.push(cmd);
}

export function addFrame(frame: FrameInfo) {
	if (devtoolsState.frames.length > 299) {
		devtoolsState.frames.splice(0, devtoolsState.frames.length - 299);
	}
	devtoolsState.frames.push(frame);
}

export function addError(error: ErrorInfo) {
	devtoolsState.errors.push(error);
}

export function addMemorySnapshot(snapshot: MemorySnapshot) {
	if (devtoolsState.memorySnapshots.length > 499) {
		devtoolsState.memorySnapshots.splice(
			0,
			devtoolsState.memorySnapshots.length - 499,
		);
	}
	devtoolsState.memorySnapshots.push(snapshot);
}

export function clearCaptures() {
	devtoolsState.captures.splice(0);
}

export function toggleCapturePaused() {
	devtoolsState.isCapturePaused = !devtoolsState.isCapturePaused;
}

export function updateSettings(patch: Partial<DevToolsSettings>) {
	Object.assign(devtoolsState.settings, patch);
}

export function updateCaptureSettings(next: CaptureSettings) {
	devtoolsState.captureSettings = next;
}
