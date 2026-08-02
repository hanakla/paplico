import { describe, expect, it } from "vitest";
import { createScriptHost, type ScriptHost } from "./ScriptHost";

function makeHost(): { host: ScriptHost; lines: string[] } {
	const lines: string[] = [];
	const host = createScriptHost({ stdout: (text) => lines.push(text) });
	return { host, lines };
}

async function runAndCapture(source: string): Promise<string[]> {
	const { host, lines } = makeHost();
	await host.runSource(source);
	return lines;
}

async function failureOf(source: string): Promise<string> {
	const { host } = makeHost();
	try {
		await host.runSource(source);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the script to fail");
}

describe("expect assertions", () => {
	it("should pass silently for satisfied expectations", async () => {
		expect(
			await runAndCapture(`
				expect(1 + 1).toEqual(2)
				expect("syrup").notToEqual("maple")
				expect(true).toBeTrue()
				expect(false).toBeFalse()
				expect(3).toBeGreaterThan(2)
				expect(3).toBeLessThan(4)
				print("done")
			`),
		).toEqual(["done"]);
	});

	it("should fail with expected and actual values", async () => {
		expect(await failureOf("expect(1 + 1).toEqual(3)")).toBe(
			"expected 3, got 2",
		);
	});

	it("should compare structs structurally", async () => {
		expect(
			await runAndCapture(`
				struct Point { let x: Number; let y: Number }
				expect(Point(x: 1, y: 2)).toEqual(Point(x: 1, y: 2))
				print("equal")
			`),
		).toEqual(["equal"]);
		expect(
			await failureOf(`
				struct Point { let x: Number; let y: Number }
				expect(Point(x: 1, y: 2)).toEqual(Point(x: 9, y: 2))
			`),
		).toBe('expected {"x":9,"y":2}, got {"x":1,"y":2}');
	});

	it("should compare arrays and enum payloads deeply", async () => {
		expect(
			await runAndCapture(`
				enum Shape { case circle(radius: Number); case dot }
				expect([1, 2, 3]).toEqual([1, 2, 3])
				expect(Shape.circle(radius: 2)).toEqual(Shape.circle(radius: 2))
				expect(Shape.circle(radius: 2)).notToEqual(Shape.dot)
				print("deep")
			`),
		).toEqual(["deep"]);
	});

	it("should check nil with optionals", async () => {
		expect(
			await runAndCapture(`
				fn firstOf(xs: Array<Number>) -> Number? { return xs.first }
				expect(firstOf([])).toBeNil()
				expect(firstOf([5])).notToBeNil()
				print("nil ok")
			`),
		).toEqual(["nil ok"]);
		expect(
			await failureOf("let n: Number? = nil\nexpect(n ?? 7).toEqual(8)"),
		).toBe("expected 8, got 7");
	});

	it("should type toEqual against the expected value's type", async () => {
		const { host } = makeHost();
		const { diagnostics } = await host.compile(`
			expect(1).toEqual("one")
		`);
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	it("should work with generic user types", async () => {
		expect(
			await runAndCapture(`
				struct Box<T> { let value: T }
				expect(Box(value: 4).value).toEqual(4)
				expect(Box(value: "s")).toEqual(Box(value: "s"))
				print("generic ok")
			`),
		).toEqual(["generic ok"]);
	});
});
