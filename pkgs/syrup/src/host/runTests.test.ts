import { describe, expect, it } from "vitest";
import { createExecutor } from "../runner/executor";
import type { WorkerLike } from "../runner/types";
import { createScriptHost, type ScriptHost } from "./ScriptHost";

function makeHost(): { host: ScriptHost; lines: string[] } {
	const lines: string[] = [];
	const host = createScriptHost({ stdout: (text) => lines.push(text) });
	return { host, lines };
}

/** Loopback "worker": in-process executor behind a structured-clone boundary. */
function createLoopbackWorker(): WorkerLike {
	let workerHandler: (message: unknown) => void = () => {};
	const workerLike: WorkerLike = {
		onmessage: null,
		postMessage(message) {
			const cloned = structuredClone(message);
			queueMicrotask(() => workerHandler(cloned));
		},
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

const SAMPLE_TESTS = `
struct Point { let x: Number; let y: Number }

fn shift(p: Point, by delta: Number) -> Point {
	return Point(x: p.x + delta, y: p.y + delta)
}

@test
fn shiftsBothAxes() {
	expect(shift(Point(x: 1, y: 2), by: 10)).toEqual(Point(x: 11, y: 12))
}

@test
fn failsOnPurpose() {
	expect(1 + 1).toEqual(3)
}

@test
fn checksStrings() {
	expect("syrup".uppercased()).toEqual("SYRUP")
}
`;

describe("ScriptHost.runTests", () => {
	it("should run every @test function and report results in order", async () => {
		const { host } = makeHost();
		expect(await host.runTests(SAMPLE_TESTS)).toEqual([
			{ name: "shiftsBothAxes", passed: true, error: null },
			{ name: "failsOnPurpose", passed: false, error: "expected 3, got 2" },
			{ name: "checksStrings", passed: true, error: null },
		]);
	});

	it("should run top-level statements before the tests", async () => {
		const { host, lines } = makeHost();
		const results = await host.runTests(`
			print("setup")
			@test
			fn logs() { print("inside test") }
		`);
		expect(lines).toEqual(["setup", "inside test"]);
		expect(results).toEqual([{ name: "logs", passed: true, error: null }]);
	});

	it("should report thrown runtime errors as failures", async () => {
		const { host } = makeHost();
		const results = await host.runTests(`
			@test
			fn forcesNil() {
				let n: Number? = nil
				print(n!)
			}
		`);
		expect(results).toHaveLength(1);
		expect(results[0].passed).toBe(false);
		expect(results[0].error).toContain("nil");
	});

	it("should exclude @test functions from normal runs", async () => {
		const { host, lines } = makeHost();
		const output = await host.compile(`
			print("main")
			@test
			fn hidden() { print("never") }
		`);
		expect(output.code).not.toContain("hidden");
		await host.run(output.code ?? "");
		expect(lines).toEqual(["main"]);
	});

	it("should run tests through the worker runner", async () => {
		const { host } = makeHost();
		const { code } = await host.compile(SAMPLE_TESTS, { mode: "test" });
		if (code === null) throw new Error("compile failed");
		const runner = host.createWorkerRunner(createLoopbackWorker());
		expect(await runner.runTests(code)).toEqual([
			{ name: "shiftsBothAxes", passed: true, error: null },
			{ name: "failsOnPurpose", passed: false, error: "expected 3, got 2" },
			{ name: "checksStrings", passed: true, error: null },
		]);
		runner.dispose();
	});
});
