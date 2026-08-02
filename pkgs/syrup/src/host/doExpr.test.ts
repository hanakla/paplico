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

async function compileErrors(source: string): Promise<string[]> {
	const { host } = makeHost();
	const output = await host.compile(source);
	return output.diagnostics.map((d) => d.message);
}

const PARSE_FAILURE = `
	class ParseFailure: Error {
		let message: String
		init(message: String) { self.message = message }
	}
	fn parse(input: String) throws -> Number {
		if input == "bad" {
			throw ParseFailure(message: "unexpected token")
		}
		return input.count
	}
`;

describe("do expressions", () => {
	it("should yield a lone expression implicitly", async () => {
		expect(
			await runAndCapture(`
				let n = do { 1 + 2 }
				print(n)
			`),
		).toEqual(["3"]);
	});

	it("should yield through return in multi-statement bodies", async () => {
		expect(
			await runAndCapture(`
				fn grade(score: Number) -> String {
					return do {
						if score >= 80 { return "A" }
						return "B"
					}
				}
				print(grade(90))
				print(grade(50))
			`),
		).toEqual(["A", "B"]);
	});

	it("should propagate the expected type into the body", async () => {
		expect(
			await runAndCapture(`
				let align: "left" | "right" = do { "left" }
				print(align)
			`),
		).toEqual(["left"]);
	});

	it("should keep loops local to the body", async () => {
		expect(
			await runAndCapture(`
				let total = do {
					var sum = 0
					for i in 0..<5 {
						if i == 3 { break }
						sum += i
					}
					return sum
				}
				print(total)
			`),
		).toEqual(["3"]);
	});

	it("should handle errors with do-catch expressions", async () => {
		expect(
			await runAndCapture(`${PARSE_FAILURE}
				fn safeParse(input: String) -> Number {
					return do { try parse(input) } catch { -1 }
				}
				print(safeParse("abc"))
				print(safeParse("bad"))
			`),
		).toEqual(["3", "-1"]);
	});

	it("should run multi-statement catch bodies with the error binding", async () => {
		expect(
			await runAndCapture(`${PARSE_FAILURE}
				let n = do {
					return try parse("bad")
				} catch {
					let captured: Error = error
					return 0
				}
				print(n)
			`),
		).toEqual(["0"]);
	});

	it("should await async operations inside a do expression", async () => {
		const { host, lines } = makeHost();
		host.registerPackage({
			name: "clock",
			declarations: "declare async fn tick() -> Number",
			runtime: { tick: async () => 42 },
			expose: "global",
		});
		await host.runSource("let x = do { await tick() }\nprint(x)");
		expect(lines).toEqual(["42"]);
	});

	describe("compile-time rules", () => {
		it("should require a value on every path", async () => {
			expect(
				await compileErrors(`
					let n = do {
						let x = 1
						if x == 1 { return 2 }
					}
					print(n)
				`),
			).toEqual(["A do expression must return a value on every path"]);
		});

		it("should reject break crossing the do boundary", async () => {
			expect(
				await compileErrors(`
					for i in 0..<3 {
						let n = do { break }
						print(n)
					}
				`),
			).toContain("'break' outside of a loop");
		});
	});
});
