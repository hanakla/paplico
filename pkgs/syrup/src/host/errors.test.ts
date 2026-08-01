import { describe, expect, it } from "vitest";
import { SAMPLES } from "../../playground/samples";
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

describe("error handling end-to-end", () => {
	it("should catch a thrown error with do-catch and resume after it", async () => {
		expect(
			await runAndCapture(`${PARSE_FAILURE}
				do {
					print(try parse("hello"))
					print(try parse("bad"))
					print("unreachable")
				} catch {
					print("caught")
				}
				print("after")
			`),
		).toEqual(["5", "caught", "after"]);
	});

	it("should bind the caught value as 'error' typed as Error", async () => {
		expect(
			await runAndCapture(`${PARSE_FAILURE}
				do {
					throw ParseFailure(message: "boom")
				} catch {
					let captured: Error = error
					print("typed")
				}
			`),
		).toEqual(["typed"]);
	});

	it("should propagate errors through throws functions", async () => {
		expect(
			await runAndCapture(`${PARSE_FAILURE}
				fn tryParse(input: String) throws -> Number {
					return try parse(input)
				}
				do {
					print(try tryParse("bad"))
				} catch {
					print("outer caught")
				}
			`),
		).toEqual(["outer caught"]);
	});

	it("should support try inside interpolation and compound assignment", async () => {
		expect(
			await runAndCapture(`${PARSE_FAILURE}
				fn parseAll(inputs: [String]) throws -> Number {
					var total = 0
					for input in inputs {
						total += try parse(input)
					}
					return total
				}
				do {
					print("total: $(try parseAll(["a", "bb", "ccc"]))")
					print("total: $(try parseAll(["a", "bad"]))")
				} catch {
					print("caught from parseAll")
				}
			`),
		).toEqual(["total: 6", "caught from parseAll"]);
	});

	it("should abort the script on an uncaught top-level throw", async () => {
		const { host } = makeHost();
		const output = await host.compile(`${PARSE_FAILURE}
			let n = try parse("bad")
		`);
		expect(output.diagnostics).toEqual([]);
		await expect(host.run(output.code as string)).rejects.toThrow(
			/Uncaught Syrup error/,
		);
	});

	it("should not catch runtime traps in do-catch", async () => {
		const { host, lines } = makeHost();
		const output = await host.compile(`
			do {
				let x: Number? = nil
				print(x!)
			} catch {
				print("should not run")
			}
		`);
		expect(output.diagnostics).toEqual([]);
		await expect(host.run(output.code as string)).rejects.toThrow(
			/force-unwrapping/,
		);
		expect(lines).toEqual([]);
	});

	it("should not let do-catch swallow expect failures", async () => {
		const { host } = makeHost();
		const results = await host.runTests(`
			@test fn swallowAttempt() {
				do {
					expect(1).toEqual(2)
				} catch {
					print("swallowed")
				}
			}
		`);
		expect(results).toHaveLength(1);
		expect(results[0].passed).toBe(false);
	});

	it("should run the playground errors sample", async () => {
		const sample = SAMPLES.find((s) => s.id === "errors");
		if (!sample) throw new Error("errors sample missing");
		expect(await runAndCapture(sample.source)).toEqual([
			"5",
			"caught an error",
			"total: 6",
			"caught from parseAll",
			"safe: 4",
			"safe: -1",
		]);
	});

	describe("compile-time rules", () => {
		it("should require 'try' on throwing calls", async () => {
			expect(
				await compileErrors(`${PARSE_FAILURE}
					do {
						print(parse("x"))
					} catch { }
				`),
			).toEqual(["Call to a throwing function must be marked with 'try'"]);
		});

		it("should reject unhandled throwing calls in non-throwing functions", async () => {
			expect(
				await compileErrors(`${PARSE_FAILURE}
					fn caller() -> Number {
						return try parse("x")
					}
				`),
			).toEqual([
				"Errors thrown from here are not handled; use do-catch or mark the enclosing function 'throws'",
			]);
		});

		it("should reject throwing calls inside closures", async () => {
			expect(
				await compileErrors(`${PARSE_FAILURE}
					do {
						let lengths = ["a"].map { s in try parse(s) }
						print(lengths.count)
					} catch { }
				`),
			).toEqual([
				"Errors thrown from here are not handled; use do-catch or mark the enclosing function 'throws'",
			]);
		});

		it("should reject thrown values that do not conform to Error", async () => {
			expect(
				await compileErrors(`
					fn boom() throws -> Void {
						let message = "x"
						throw message
					}
				`),
			).toEqual(["Thrown values must conform to 'Error', got 'String'"]);
		});

		it("should reject 'try' without throwing operations", async () => {
			expect(
				await compileErrors(`
					fn pure() -> Number { return 1 }
					let x = try pure()
				`),
			).toEqual(["'try' has no throwing operations"]);
		});
	});
});
