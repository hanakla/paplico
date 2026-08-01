import { createExecutor } from "./executor";

// Minimal structural typing of the dedicated worker scope, so this package
// never depends on DOM/WebWorker lib types.
declare const self: {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: unknown }) => void) | null;
};

/**
 * Install the Syrup executor in a dedicated Web Worker. Bundlers point a
 * worker entry file at this (see the playground for a Vite example):
 *
 * ```typescript
 * import { installWorkerRuntime } from "@paplico/syrup/worker";
 * installWorkerRuntime();
 * ```
 */
export function installWorkerRuntime(): void {
	createExecutor({
		post: (message) => self.postMessage(message),
		onMessage: (handler) => {
			self.onmessage = (event) => handler(event.data);
		},
	});
}
