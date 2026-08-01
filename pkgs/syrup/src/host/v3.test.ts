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

describe("unions, literal types, and narrowing end-to-end", () => {
	describe("literal types", () => {
		it("should type literal unions and switch exhaustively without default", async () => {
			expect(
				await runAndCapture(`
					let align: "left" | "center" | "right" = "center"
					switch align {
					case "left":
						print("L")
					case "center":
						print("C")
					case "right":
						print("R")
					}
				`),
			).toEqual(["C"]);
		});

		it("should mix literals with a base type", async () => {
			expect(
				await runAndCapture(`
					fn pad(v: "auto" | Number) -> String {
						switch v {
						case "auto":
							return "auto"
						default:
							return "px"
						}
					}
					print(pad("auto"))
					print(pad(12))
				`),
			).toEqual(["auto", "px"]);
		});
	});

	describe("is narrowing", () => {
		it("should narrow through if/else branches", async () => {
			expect(
				await runAndCapture(`
					fn describe(v: String | Number) -> String {
						if v is String {
							return v.uppercased()
						} else {
							return "$(v * 2)"
						}
					}
					print(describe("hey"))
					print(describe(21))
				`),
			).toEqual(["HEY", "42"]);
		});

		it("should narrow after guard is", async () => {
			expect(
				await runAndCapture(`
					fn bump(v: String | Number) -> Number {
						guard v is Number else { return 0 - 1 }
						return v + 1
					}
					print(bump(41))
					print(bump("x"))
				`),
			).toEqual(["42", "-1"]);
		});

		it("should narrow the subject in switch type patterns", async () => {
			expect(
				await runAndCapture(`
					fn size(v: String | Number | [Number]) -> Number {
						switch v {
						case is String:
							return v.count
						case is Number:
							return v
						case is [Number]:
							return v.count
						}
					}
					print(size("abc"))
					print(size(7))
					print(size([1, 2, 3, 4]))
				`),
			).toEqual(["3", "7", "4"]);
		});

		it("should narrow struct members of unions", async () => {
			expect(
				await runAndCapture(`
					struct Point { var x: Number; var y: Number }
					fn describe(v: Point | String) -> Number {
						if v is Point {
							return v.x + v.y
						}
						return 0
					}
					print(describe(Point(x: 1, y: 2)))
					print(describe("nope"))
				`),
			).toEqual(["3", "0"]);
		});

		it("should narrow optionals with != nil", async () => {
			expect(
				await runAndCapture(`
					fn next(v: Number?) -> Number {
						if v != nil {
							return v + 1
						}
						return 0
					}
					print(next(41))
					print(next(nil))
				`),
			).toEqual(["42", "0"]);
		});
	});

	describe("runtime helper tree-shaking", () => {
		it("should omit helpers the program never uses", async () => {
			const { host } = makeHost();
			const output = await host.compile("print(1)");
			expect(output.code).not.toBeNull();
			expect(output.code).not.toContain("__sorted");
			expect(output.code).not.toContain("__arrMap");
			expect(output.code).not.toContain("__force");
		});

		it("should include helpers the program references", async () => {
			const { host } = makeHost();
			const output = await host.compile("let x: Number? = 1\nprint(x!)");
			expect(output.code).not.toBeNull();
			expect(output.code).toContain("const __force");
			expect(output.code).not.toContain("__sorted");
		});
	});

	describe("Swift-style dictionaries", () => {
		it("should read exhaustive-key dictionaries without optionals", async () => {
			expect(
				await runAndCapture(`
					let sides: ["left" | "right": Number] = [left: 1, right: 2]
					print(sides["left"] + sides["right"])
				`),
			).toEqual(["3"]);
		});

		it("should accept Record as a Dictionary alias", async () => {
			expect(
				await runAndCapture(`
					var m: Record<String, Number> = [a: 1]
					m["b"] = 2
					print(m.count)
				`),
			).toEqual(["2"]);
		});

		it("should support computed keys for String-keyed dictionaries", async () => {
			expect(
				await runAndCapture(`
					let key = "dy"
					let d = [[key]: 4, base: 1]
					print(d["dy"] ?? 0)
					print(d["base"] ?? 0)
				`),
			).toEqual(["4", "1"]);
		});
	});
});
