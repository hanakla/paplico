import { describe, expect, it } from "vitest";
import { checkProgram } from "../checker/check";
import { emitBundle, moduleJsName } from "../emit/emitter";
import { createScriptHost } from "../host/ScriptHost";
import { parseProgram } from "../syntax/cstToAst";
import { createExecutor } from "./executor";
import type { WorkerLike } from "./types";

/**
 * A loopback "worker": the executor runs in-process, but every message is
 * structured-cloned like a real postMessage boundary.
 */
function createLoopbackWorker(onTerminate: () => void = () => {}): WorkerLike {
	let workerHandler: (message: unknown) => void = () => {};
	const workerLike: WorkerLike = {
		onmessage: null,
		postMessage(message) {
			const cloned = structuredClone(message);
			queueMicrotask(() => workerHandler(cloned));
		},
		terminate: onTerminate,
	};
	createExecutor({
		post: (message) => {
			const cloned = structuredClone(message);
			queueMicrotask(() => workerLike.onmessage?.({ data: cloned }));
		},
		onMessage: (handler) => {
			workerHandler = handler;
		},
	});
	return workerLike;
}

function makeWorkerHost() {
	const lines: string[] = [];
	const host = createScriptHost({ stdout: (text) => lines.push(text) });
	const calls: unknown[][] = [];
	host.registerPackage({
		name: "paplico",
		declarations: `
			declare type Layer {
				let name: String
				var opacity: Number
				fn addChild(child: Layer) -> Void
				fn childCount() -> Number
			}
			declare fn addLayer(name: String) -> Layer
			declare fn find(key: String) -> Layer?
			declare fn transform(f: (Number) -> Number) -> Number
		`,
		runtime: {
			addLayer: (name: string) => {
				calls.push(["addLayer", name]);
				const children: unknown[] = [];
				return {
					name,
					opacity: 1,
					addChild: (child: unknown) => {
						children.push(child);
					},
					childCount: () => children.length,
				};
			},
			find: () => undefined,
			transform: (f: (n: number) => number) => f(1),
		},
	});
	const runner = host.createWorkerRunner(createLoopbackWorker());
	return { host, lines, calls, runner };
}

describe("worker sandbox runner", () => {
	it("should run print and host calls over the RPC boundary", async () => {
		const { host, lines, calls, runner } = makeWorkerHost();
		const output = await host.compile(`
			let bg = paplico.addLayer(name: "bg")
			bg.opacity = 0.5
			bg.addChild(paplico.addLayer(name: "child"))
			print(bg.name)
			print(bg.opacity)
			print(bg.childCount())
		`);
		expect(output.code).not.toBeNull();
		await runner.run(output.code as string);
		expect(calls).toEqual([
			["addLayer", "bg"],
			["addLayer", "child"],
		]);
		expect(lines).toEqual(["bg", "0.5", "1"]);
	});

	it("should normalize undefined optionals across the boundary", async () => {
		const { host, lines, runner } = makeWorkerHost();
		const output = await host.compile(`
			if let layer = paplico.find("x") {
				print(layer.name)
			} else {
				print("none")
			}
		`);
		expect(output.code).not.toBeNull();
		await runner.run(output.code as string);
		expect(lines).toEqual(["none"]);
	});

	it("should run pure computation (closures, structs) inside the worker", async () => {
		const { host, lines, runner } = makeWorkerHost();
		const output = await host.compile(`
			struct Point { var x: Number; var y: Number }
			var a = Point(x: 1, y: 2)
			var b = a
			b.x = 99
			print(a.x)
			let total = [1, 2, 3].map { $0 * 10 }.reduce(0) { acc, n in acc + n }
			print(total)
		`);
		expect(output.code).not.toBeNull();
		await runner.run(output.code as string);
		expect(lines).toEqual(["1", "60"]);
	});

	it("should reject function arguments at the worker boundary", async () => {
		const { host, runner } = makeWorkerHost();
		const output = await host.compile(`
			let r = paplico.transform { $0 + 1 }
			print(r)
		`);
		expect(output.code).not.toBeNull();
		await expect(runner.run(output.code as string)).rejects.toThrow(
			/worker boundary/,
		);
	});

	it("should flatten struct instances crossing the worker boundary", async () => {
		const { host, lines, runner } = makeWorkerHost();
		const output = await host.compile(`
			struct Point { var x: Number; var y: Number }
			print(Point(x: 1, y: 2))
		`);
		expect(output.code).not.toBeNull();
		await runner.run(output.code as string);
		expect(lines).toEqual(['{"x":1,"y":2}']);
	});

	it("should reject class instances at the worker boundary", async () => {
		const { host, runner } = makeWorkerHost();
		const output = await host.compile(`
			class Box {
				var v: Number = 1
				init() { }
			}
			print(Box())
		`);
		expect(output.code).not.toBeNull();
		await expect(runner.run(output.code as string)).rejects.toThrow(
			/Class instances cannot cross the worker boundary/,
		);
	});

	it("should run the same code in-process where functions are allowed", async () => {
		const { host, lines } = makeWorkerHost();
		const output = await host.compile(`
			let r = paplico.transform { $0 + 1 }
			print(r)
		`);
		expect(output.code).not.toBeNull();
		await host.run(output.code as string);
		expect(lines).toEqual(["2"]);
	});

	it("should invoke an exported module function inside the worker", async () => {
		const { runner } = makeWorkerHost();
		const moduleCode = "return { add: async (a, b) => a + b };";

		await expect(
			runner.invokeModule(moduleCode, {
				exportName: "add",
				args: [2, 3],
			}),
		).resolves.toBe(5);
	});

	it("should compile and invoke a Syrup module export inside the worker", async () => {
		const { runner } = makeWorkerHost();
		const { ast, diagnostics } = parseProgram(`
			export fn multiply(a: Number, b: Number) -> Number {
				return a * b
			}
		`);
		const check = checkProgram(ast, [], {
			mode: "module",
			moduleName: "workerModule",
			imports: [],
		});
		expect([...diagnostics, ...check.diagnostics]).toEqual([]);
		const moduleCode = `${emitBundle([
			{ moduleName: "workerModule", ast, check },
		])}\nreturn ${moduleJsName("workerModule")};`;

		await expect(
			runner.invokeModule(moduleCode, {
				exportName: "multiply",
				args: [6, 7],
			}),
		).resolves.toBe(42);
	});

	it("should reject an active run when stopped", async () => {
		const host = createScriptHost();
		let terminated = false;
		const runner = host.createWorkerRunner(
			createLoopbackWorker(() => {
				terminated = true;
			}),
		);
		const run = runner.run("await new Promise(() => {});");

		runner.stop();

		await expect(run).rejects.toThrow("Script execution stopped");
		expect(terminated).toBe(true);
	});

	it("should terminate and reject an operation that exceeds its timeout", async () => {
		const host = createScriptHost();
		let terminated = false;
		const runner = host.createWorkerRunner(
			createLoopbackWorker(() => {
				terminated = true;
			}),
			{ timeoutMs: 1 },
		);

		await expect(runner.run("await new Promise(() => {});")).rejects.toThrow(
			"timed out after 1ms",
		);
		expect(terminated).toBe(true);
	});
});
