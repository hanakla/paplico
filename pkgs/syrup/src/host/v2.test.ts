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

describe("v2 features end-to-end", () => {
	describe("dictionaries", () => {
		it("should support literals, subscripts, iteration, and members", async () => {
			expect(
				await runAndCapture(`
					var scores: [String: Number] = [a: 1]
					scores["b"] = 2
					print(scores.count)
					print(scores["a"] ?? 0)
					print(scores["zz"] ?? 0 - 1)
					var total = 0
					var names = ""
					for (key, value) in scores {
						total += value
						names += key
					}
					print(total)
					print(names)
					print(scores.keys.count)
					let removed = scores.removeValue(forKey: "a")
					print(removed ?? 0 - 9)
					print(scores.count)
					let empty: [String: Number] = [:]
					print(empty.isEmpty)
				`),
			).toEqual(["2", "1", "-1", "3", "ab", "2", "1", "1", "true"]);
		});

		it("should support [T] array sugar", async () => {
			expect(
				await runAndCapture(`
					let xs: [Number] = [1, 2, 3]
					print(xs.count)
				`),
			).toEqual(["3"]);
		});
	});

	describe("guard", () => {
		it("should bind guard let values for the rest of the scope", async () => {
			expect(
				await runAndCapture(`
					fn score(v: Number?) -> Number {
						guard let x = v else { return 0 - 1 }
						return x * 2
					}
					print(score(nil))
					print(score(21))
				`),
			).toEqual(["-1", "42"]);
		});

		it("should support guard with plain conditions in loops", async () => {
			expect(
				await runAndCapture(`
					var total = 0
					for i in 1...5 {
						guard i % 2 == 0 else { continue }
						total += i
					}
					print(total)
				`),
			).toEqual(["6"]);
		});
	});

	describe("user-defined generics", () => {
		it("should infer struct type arguments from the initializer", async () => {
			expect(
				await runAndCapture(`
					struct Pair<A, B> { var first: A; var second: B }
					let p = Pair(first: 1, second: "x")
					print(p.first)
					print(p.second)
				`),
			).toEqual(["1", "x"]);
		});

		it("should keep value semantics for generic structs", async () => {
			expect(
				await runAndCapture(`
					struct Pair<A, B> { var first: A; var second: B }
					var a = Pair(first: 1, second: 2)
					var b = a
					b.first = 99
					print(a.first)
				`),
			).toEqual(["1"]);
		});

		it("should support generic enums with switch matching", async () => {
			expect(
				await runAndCapture(`
					enum Maybe<T> { case none; case some(value: T) }
					fn unwrapOr<T>(m: Maybe<T>, fallback: T) -> T {
						switch m {
						case .some(let v):
							return v
						case .none:
							return fallback
						}
					}
					let m: Maybe<Number> = Maybe.some(value: 5)
					print(unwrapOr(m, fallback: 0))
					let n: Maybe<Number> = Maybe.none
					print(unwrapOr(n, fallback: 7))
				`),
			).toEqual(["5", "7"]);
		});
	});

	describe("async / await", () => {
		it("should await host async functions at top level and in async fns", async () => {
			const { host, lines } = makeHost();
			host.registerPackage({
				name: "io",
				declarations: "declare async fn load(key: String) -> Number",
				runtime: { load: async (key: string) => key.length },
			});
			await host.runSource(`
				let n = await io.load("abcd")
				print(n)
				async fn twice() -> Number {
					return (await io.load("ab")) * 2
				}
				print(await twice())
			`);
			expect(lines).toEqual(["4", "4"]);
		});
	});

	describe("modules", () => {
		function moduleHost(): { host: ScriptHost; lines: string[] } {
			const { host, lines } = makeHost();
			host.setModuleResolver((specifier) => {
				if (specifier === "brushes") {
					return `
						export let baseSize = 12
						export fn double(n: Number) -> Number { return n * 2 }
						export struct Brush { var size: Number }
						fn hidden() -> Number { return 1 }
					`;
				}
				return null;
			});
			return { host, lines };
		}

		it("should import module values and hoist exported types", async () => {
			const { host, lines } = moduleHost();
			await host.runSource(`
				use brushes from "brushes"
				print(brushes.baseSize)
				print(brushes.double(21))
				let b = Brush(size: brushes.baseSize)
				print(b.size)
			`);
			expect(lines).toEqual(["12", "42", "12"]);
		});

		it("should bind named exports with use { }", async () => {
			const { host, lines } = moduleHost();
			await host.runSource(`
				use { double, baseSize } from "brushes"
				print(double(baseSize))
			`);
			expect(lines).toEqual(["24"]);
		});

		it("should bind named exported types", async () => {
			const { host, lines } = moduleHost();
			await host.runSource(`
				use { Brush } from "brushes"
				let b = Brush(size: 3)
				print(b.size)
			`);
			expect(lines).toEqual(["3"]);
		});

		it("should bind the namespace under any name", async () => {
			const { host, lines } = moduleHost();
			await host.runSource(`
				use b from "brushes"
				print(b.double(2))
			`);
			expect(lines).toEqual(["4"]);
		});

		it("should support non-identifier module specifiers", async () => {
			const { host, lines } = makeHost();
			host.setModuleResolver((specifier) =>
				specifier === "pkgs/geo"
					? "export fn square(n: Number) -> Number { return n * n }"
					: null,
			);
			await host.runSource(`
				use geo from "pkgs/geo"
				print(geo.square(7))
			`);
			expect(lines).toEqual(["49"]);
		});

		it("should report unknown named exports", async () => {
			const { host } = moduleHost();
			const output = await host.compile('use { nope } from "brushes"');
			expect(output.code).toBeNull();
			expect(
				output.diagnostics.some((d) =>
					d.message.includes("has no export 'nope'"),
				),
			).toBe(true);
		});

		it("should hide non-exported members", async () => {
			const { host } = moduleHost();
			const output = await host.compile(
				'use brushes from "brushes"\nbrushes.hidden()',
			);
			expect(output.code).toBeNull();
			expect(
				output.diagnostics.some((d) =>
					d.message.includes("has no member 'hidden'"),
				),
			).toBe(true);
		});

		it("should report unresolved modules", async () => {
			const { host } = moduleHost();
			const output = await host.compile('use missing from "missing"');
			expect(output.code).toBeNull();
			expect(
				output.diagnostics.some((d) =>
					d.message.includes("Cannot resolve module 'missing'"),
				),
			).toBe(true);
		});

		it("should report circular imports", async () => {
			const { host } = makeHost();
			host.setModuleResolver((specifier) => {
				if (specifier === "a") return 'use b from "b"\nexport let x = 1';
				if (specifier === "b") return 'use a from "a"\nexport let y = 2';
				return null;
			});
			const output = await host.compile('use a from "a"');
			expect(output.code).toBeNull();
			expect(
				output.diagnostics.some((d) => d.message.includes("Circular import")),
			).toBe(true);
		});

		it("should prefix module diagnostics with the module name", async () => {
			const { host } = makeHost();
			host.setModuleResolver(() => 'export let broken: Number = "no"');
			const output = await host.compile('use bad from "bad"');
			expect(output.code).toBeNull();
			expect(
				output.diagnostics.some((d) => d.message.startsWith("[module bad]")),
			).toBe(true);
		});

		it("should support transitive imports with async resolvers", async () => {
			const { host, lines } = makeHost();
			host.setModuleResolver(async (specifier) => {
				if (specifier === "outer") {
					return 'use inner from "inner"\nexport fn get() -> Number { return inner.value + 1 }';
				}
				if (specifier === "inner") return "export let value = 41";
				return null;
			});
			await host.runSource(`
				use outer from "outer"
				print(outer.get())
			`);
			expect(lines).toEqual(["42"]);
		});
	});
});
