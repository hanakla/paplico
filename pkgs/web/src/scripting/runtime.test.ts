import type { WorkerLike } from "@paplico/syrup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationPromptRequest } from "@/automation/types";
import type { Paplico } from "@/core/Paplico";
import { createPaplicoAutomationRuntime } from "./runtime";

const dom = vi.hoisted(() => ({
	begin: vi.fn(),
	commit: vi.fn(),
	rollback: vi.fn(),
}));

vi.mock("./dom", () => ({
	PaplicoAutomationDom: class {
		public begin = dom.begin;
		public commit = dom.commit;
		public rollback = dom.rollback;
	},
}));

describe("createPaplicoAutomationRuntime", () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("should execute top-level source directly and commit successful changes", async () => {
		const worker = createControllableWorker("execute");
		const runtime = createRuntime(worker);

		await expect(
			runtime.run(`
				guard false else { return }
				let unreachable = 1
			`),
		).resolves.toMatchObject({ diagnostics: [] });

		expect(await worker.started).toContain("return");
		expect(dom.begin).toHaveBeenCalledOnce();
		expect(dom.commit).toHaveBeenCalledOnce();
		expect(dom.rollback).not.toHaveBeenCalled();
	});

	it("should rollback changes when worker execution fails", async () => {
		const runtime = createRuntime(createControllableWorker("error"));

		await expect(runtime.run("let value = 1")).rejects.toThrow(
			"runtime failed",
		);

		expect(dom.begin).toHaveBeenCalledOnce();
		expect(dom.commit).not.toHaveBeenCalled();
		expect(dom.rollback).toHaveBeenCalledOnce();
	});

	it("should rollback changes when execution is stopped", async () => {
		const worker = createControllableWorker("hang");
		const runtime = createRuntime(worker);
		const run = runtime.run("let value = 1");
		await worker.started;
		const stopped = expect(run).rejects.toThrow("Script execution stopped");

		runtime.stop();

		await stopped;
		expect(dom.commit).not.toHaveBeenCalled();
		expect(dom.rollback).toHaveBeenCalledOnce();
	});

	it("should rollback changes when execution exceeds the timeout", async () => {
		vi.useFakeTimers();
		const worker = createControllableWorker("hang");
		const runtime = createRuntime(worker);
		const run = runtime.run("let value = 1");
		await worker.started;
		const timedOut = expect(run).rejects.toThrow("timed out after 60000ms");

		await vi.advanceTimersByTimeAsync(60_000);

		await timedOut;
		expect(dom.commit).not.toHaveBeenCalled();
		expect(dom.rollback).toHaveBeenCalledOnce();
	});

	it("should route alert and confirm through the runtime prompt callback", async () => {
		const worker = createPromptWorker();
		const requests: AutomationPromptRequest[] = [];
		const signals: AbortSignal[] = [];
		const runtime = createPaplicoAutomationRuntime({
			paplico: {} as Paplico,
			createWorker: () => worker,
			prompt: async (request, signal) => {
				requests.push(request);
				signals.push(signal);
				return request.kind === "confirm";
			},
		});

		await runtime.run(`
			await paplico.prompt.alert(message: "Saved")
			let confirmed = await paplico.prompt.confirm(message: "Continue?")
		`);

		expect(requests).toEqual([
			{ kind: "alert", message: "Saved" },
			{ kind: "confirm", message: "Continue?" },
		]);
		expect(worker.confirmResult).toBe(true);
		expect(signals).toHaveLength(2);
		expect(signals[0]).toBe(signals[1]);
		expect(signals[0]?.aborted).toBe(true);
	});
});

function createRuntime(worker: WorkerLike) {
	return createPaplicoAutomationRuntime({
		paplico: {} as Paplico,
		createWorker: () => worker,
	});
}

function createControllableWorker(
	mode: "execute" | "error" | "hang",
): WorkerLike & { started: Promise<string> } {
	const { promise: started, resolve: resolveStarted } =
		Promise.withResolvers<string>();
	const worker: WorkerLike & { started: Promise<string> } = {
		onmessage: null,
		started,
		postMessage(message) {
			if (!isRunRequest(message)) return;
			resolveStarted(message.code);
			if (mode === "hang") return;
			if (mode === "error") {
				queueMicrotask(() => {
					worker.onmessage?.({
						data: { type: "error", message: "runtime failed" },
					});
				});
				return;
			}

			queueMicrotask(async () => {
				try {
					const execute = new AsyncFunction("__host", message.code);
					const value = await execute({});
					worker.onmessage?.({ data: { type: "done", value } });
				} catch (error) {
					worker.onmessage?.({
						data: {
							type: "error",
							message: error instanceof Error ? error.message : String(error),
						},
					});
				}
			});
		},
		terminate: vi.fn(),
	};
	return worker;
}

function createPromptWorker(): WorkerLike & { confirmResult?: unknown } {
	let promptHandle: unknown;
	const worker: WorkerLike & { confirmResult?: unknown } = {
		onmessage: null,
		postMessage(message) {
			if (!isMessage(message)) return;
			if (message.type === "run") {
				queueMicrotask(() => {
					worker.onmessage?.({
						data: {
							type: "hostCall",
							id: 1,
							op: "get",
							pkg: "paplico",
							member: "prompt",
						},
					});
				});
				return;
			}
			if (message.type !== "result") return;
			if (message.id === 1) {
				promptHandle = message.value;
				worker.onmessage?.({
					data: {
						type: "hostCall",
						id: 2,
						op: "method",
						target: promptHandle,
						name: "alert",
						args: ["Saved"],
					},
				});
				return;
			}
			if (message.id === 2) {
				worker.onmessage?.({
					data: {
						type: "hostCall",
						id: 3,
						op: "method",
						target: promptHandle,
						name: "confirm",
						args: ["Continue?"],
					},
				});
				return;
			}
			if (message.id === 3) {
				worker.confirmResult = message.value;
				worker.onmessage?.({ data: { type: "done" } });
			}
		},
		terminate: vi.fn(),
	};
	return worker;
}

function isRunRequest(value: unknown): value is { type: "run"; code: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "run" &&
		"code" in value &&
		typeof value.code === "string"
	);
}

function isMessage(
	value: unknown,
): value is { type: string; id?: number; value?: unknown } {
	return typeof value === "object" && value !== null && "type" in value;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
