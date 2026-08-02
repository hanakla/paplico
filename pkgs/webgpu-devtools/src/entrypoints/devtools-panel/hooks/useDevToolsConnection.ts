import { useCallback, useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import type {
	BufferDataResponse,
	CaptureSettings,
	CommandInfo,
	DeviceInfo,
	DevToolsSettings,
	ErrorInfo,
	FrameInfo,
	MemorySnapshot,
	ResourceInfo,
	TextureDataResponse,
	WebGPUMessage,
} from "../../../types";
import {
	addCommand,
	addDevice,
	addError,
	addFrame,
	addMemorySnapshot,
	addResource,
	clearCaptures,
	devtoolsState,
	removeResource,
	resetState,
	toggleCapturePaused,
	updateCaptureSettings,
	updateSettings,
} from "../store";

export function useDevToolsConnection() {
	const snap = useSnapshot(devtoolsState);
	const portRef = useRef<browser.runtime.Port | null>(null);
	const bufferCallbacksRef = useRef<
		Map<string, (data: BufferDataResponse) => void>
	>(new Map());
	const textureCallbacksRef = useRef<
		Map<string, (data: TextureDataResponse) => void>
	>(new Map());

	useEffect(() => {
		if (typeof browser === "undefined" || !browser.runtime?.connect) {
			devtoolsState.isConnected = false;
			return;
		}

		const port = browser.runtime.connect({ name: "webgpu-devtools-panel" });
		portRef.current = port;
		devtoolsState.isConnected = true;

		port.postMessage({
			type: "WEBGPU_PANEL_READY",
			tabId: browser.devtools.inspectedWindow.tabId,
		});

		// Load saved settings
		browser.storage.local
			.get("devtoolsSettings")
			.then((result) => {
				const saved = result.devtoolsSettings as DevToolsSettings | undefined;
				if (saved) {
					updateSettings(saved);
					port.postMessage({
						source: "webgpu-devtools",
						type: "WEBGPU_SETTINGS_CHANGED",
						payload: saved,
						tabId: browser.devtools.inspectedWindow.tabId,
					});
				}
			})
			.catch(console.warn);

		// Load saved capture settings
		browser.storage.local
			.get("captureSettings")
			.then((result) => {
				const saved = result.captureSettings as CaptureSettings | undefined;
				if (saved) updateCaptureSettings({ rules: saved.rules ?? [] });
			})
			.catch(console.warn);

		const onNavigated = () => {
			if (!devtoolsState.settings.preserveOnReload) {
				resetState();
			}
			port.postMessage({
				source: "webgpu-devtools",
				type: "WEBGPU_SETTINGS_CHANGED",
				payload: devtoolsState.settings,
				tabId: browser.devtools.inspectedWindow.tabId,
			});
		};
		browser.devtools.network.onNavigated.addListener(onNavigated);

		port.onMessage.addListener((msg: WebGPUMessage) => {
			if (msg.type === "WEBGPU_BUFFER_DATA") {
				const resp = msg.payload as BufferDataResponse;
				bufferCallbacksRef.current.get(resp.resourceId)?.(resp);
				bufferCallbacksRef.current.delete(resp.resourceId);
				return;
			}
			if (msg.type === "WEBGPU_TEXTURE_DATA") {
				const resp = msg.payload as TextureDataResponse;
				textureCallbacksRef.current.get(resp.resourceId)?.(resp);
				textureCallbacksRef.current.delete(resp.resourceId);
				return;
			}

			if (!devtoolsState.isRecording) return;

			switch (msg.type) {
				case "WEBGPU_DEVICE_CREATED":
					addDevice(msg.payload as DeviceInfo);
					break;
				case "WEBGPU_RESOURCE_CREATED":
					addResource(msg.payload as ResourceInfo);
					break;
				case "WEBGPU_RESOURCE_DESTROYED":
					removeResource((msg.payload as { id: string }).id);
					break;
				case "WEBGPU_COMMAND_RECORDED":
					addCommand(msg.payload as CommandInfo);
					break;
				case "WEBGPU_FRAME_BOUNDARY":
					addFrame(msg.payload as FrameInfo);
					break;
				case "WEBGPU_ERROR":
					addError(msg.payload as ErrorInfo);
					break;
				case "WEBGPU_MEMORY_SNAPSHOT":
					addMemorySnapshot(msg.payload as MemorySnapshot);
					break;
			}
		});

		port.onDisconnect.addListener(() => {
			devtoolsState.isConnected = false;
			portRef.current = null;
		});

		return () => {
			browser.devtools.network.onNavigated.removeListener(onNavigated);
			port.disconnect();
		};
	}, []);

	const toggleRecording = useCallback(() => {
		devtoolsState.isRecording = !devtoolsState.isRecording;
	}, []);

	const clearState = useCallback(() => {
		resetState();
	}, []);

	const requestBufferData = useCallback(
		(resourceId: string): Promise<BufferDataResponse> => {
			return new Promise((resolve) => {
				bufferCallbacksRef.current.set(resourceId, resolve);
				portRef.current?.postMessage({
					source: "webgpu-devtools",
					type: "WEBGPU_REQUEST_BUFFER_DATA",
					payload: { resourceId },
					tabId: browser.devtools.inspectedWindow.tabId,
				});
			});
		},
		[],
	);

	const handleUpdateSettings = useCallback(
		(patch: Partial<DevToolsSettings>) => {
			updateSettings(patch);
			browser.storage.local
				.set({ devtoolsSettings: devtoolsState.settings })
				.catch(console.warn);
			portRef.current?.postMessage({
				source: "webgpu-devtools",
				type: "WEBGPU_SETTINGS_CHANGED",
				payload: devtoolsState.settings,
				tabId: browser.devtools.inspectedWindow.tabId,
			});
		},
		[],
	);

	const handleUpdateCaptureSettings = useCallback((next: CaptureSettings) => {
		updateCaptureSettings(next);
		browser.storage.local.set({ captureSettings: next }).catch(console.warn);
	}, []);

	const requestTextureData = useCallback(
		(resourceId: string): Promise<TextureDataResponse> => {
			return new Promise((resolve) => {
				textureCallbacksRef.current.set(resourceId, resolve);
				portRef.current?.postMessage({
					source: "webgpu-devtools",
					type: "WEBGPU_REQUEST_TEXTURE_DATA",
					payload: { resourceId },
					tabId: browser.devtools.inspectedWindow.tabId,
				});
			});
		},
		[],
	);

	return {
		state: {
			devices: snap.devices,
			resources: snap.resources,
			commands: snap.commands,
			frames: snap.frames,
			errors: snap.errors,
			memorySnapshots: snap.memorySnapshots,
			captures: snap.captures,
		},
		isConnected: snap.isConnected,
		isRecording: snap.isRecording,
		isCapturePaused: snap.isCapturePaused,
		settings: snap.settings,
		captureSettings: snap.captureSettings,
		toggleRecording,
		clearState,
		updateSettings: handleUpdateSettings,
		updateCaptureSettings: handleUpdateCaptureSettings,
		clearCaptures,
		toggleCapturePaused,
		requestBufferData,
		requestTextureData,
	};
}
