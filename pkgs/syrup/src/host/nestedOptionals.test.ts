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

describe("nested optionals end-to-end", () => {
	describe("Array.first / .last", () => {
		it("should distinguish a nil first element from an empty array", async () => {
			expect(
				await runAndCapture(`
					let xs: [Number?] = [nil, 1]
					if let v = xs.first {
						print("some: $(v ?? -1)")
					} else {
						print("none")
					}
					let empty: [Number?] = []
					if let v = empty.first {
						print("some: $(v ?? -1)")
					} else {
						print("none")
					}
					let plain: [Number?] = [2]
					if let v = plain.first {
						print("some: $(v ?? -1)")
					} else {
						print("none")
					}
				`),
			).toEqual(["some: -1", "none", "some: 2"]);
		});

		it("should unwrap only one level with ??, like Swift", async () => {
			expect(
				await runAndCapture(`
					let xs: [Number?] = [nil]
					let v = xs.first ?? 9
					print(v ?? -1)
					let empty: [Number?] = []
					print((empty.first ?? 9) ?? -1)
				`),
			).toEqual(["-1", "9"]);
		});

		it("should force-unwrap into the inner optional", async () => {
			expect(
				await runAndCapture(`
					let xs: [Number?] = [nil, 1]
					print(xs.first! ?? -1)
					print(xs.last! ?? -1)
				`),
			).toEqual(["-1", "1"]);
		});

		it("should still trap when force-unwrapping the outer none", async () => {
			const { host } = makeHost();
			const output = await host.compile(`
				let empty: [Number?] = []
				print(empty.first! ?? -1)
			`);
			expect(output.diagnostics).toEqual([]);
			await expect(host.run(output.code as string)).rejects.toThrow(
				/force-unwrapping/,
			);
		});

		it("should print boxed values Swift-style", async () => {
			expect(
				await runAndCapture(`
					let xs: [Number?] = [nil, 3]
					print(xs.first)
					print(xs.last)
					let empty: [Number?] = []
					print(empty.first)
					print("first: $(xs.first)")
				`),
			).toEqual([
				"Optional(nil)",
				"Optional(3)",
				"nil",
				"first: Optional(nil)",
			]);
		});

		it("should keep nested results through ?. chains", async () => {
			expect(
				await runAndCapture(`
					let xs: [Number?] = [nil]
					let oxs: [Number?]? = xs
					print(oxs?.first)
					let nxs: [Number?]? = nil
					print(nxs?.first)
				`),
			).toEqual(["Optional(nil)", "nil"]);
		});
	});

	describe("dictionaries with optional values", () => {
		it("should distinguish a stored nil from a missing key", async () => {
			expect(
				await runAndCapture(`
					let d: [String: Number?] = ["a": nil, "b": 2]
					if let v = d["a"] {
						print("a: $(v ?? -1)")
					} else {
						print("a: none")
					}
					if let v = d["b"] {
						print("b: $(v ?? -1)")
					} else {
						print("b: none")
					}
					if let v = d["c"] {
						print("c: $(v ?? -1)")
					} else {
						print("c: none")
					}
				`),
			).toEqual(["a: -1", "b: 2", "c: none"]);
		});

		it("should box removeValue results", async () => {
			expect(
				await runAndCapture(`
					var d: [String: Number?] = ["a": nil]
					print(d.removeValue(forKey: "a"))
					print(d.removeValue(forKey: "a"))
				`),
			).toEqual(["Optional(nil)", "nil"]);
		});
	});

	describe("Number?? annotations and injection", () => {
		it("should parse T?? and build values by injection", async () => {
			expect(
				await runAndCapture(`
					let a: Number?? = nil
					let inner: Number? = nil
					let b: Number?? = inner
					let c: Number?? = 5
					print(a)
					print(b)
					print(c)
					if let u = b {
						print("b is some: $(u ?? -1)")
					}
					let z: Optional<Optional<Number>> = c
					print(z)
				`),
			).toEqual([
				"nil",
				"Optional(nil)",
				"Optional(5)",
				"b is some: -1",
				"Optional(5)",
			]);
		});

		it("should not narrow boxed optionals on a nil test", async () => {
			expect(
				await compileErrors(`
					let x: Number?? = 5
					if x != nil {
						let y: Number? = x
						print(y ?? -1)
					}
				`),
			).toEqual(["Type 'Number??' is not assignable to 'Number?'"]);
		});
	});

	describe("user generic functions", () => {
		const FIRST_OF = `
			fn firstOf<T>(xs: [T]) -> T? {
				return xs.first
			}
		`;

		it("should unbox results when T is not optional", async () => {
			expect(
				await runAndCapture(`${FIRST_OF}
					let nums = [10, 20]
					print(firstOf(xs: nums) ?? -1)
					let empty: [Number] = []
					print(firstOf(xs: empty) ?? -1)
				`),
			).toEqual(["10", "-1"]);
		});

		it("should keep nesting when T is optional", async () => {
			expect(
				await runAndCapture(`${FIRST_OF}
					let maybes: [Number?] = [nil]
					print(firstOf(xs: maybes))
					let empty: [Number?] = []
					print(firstOf(xs: empty))
				`),
			).toEqual(["Optional(nil)", "nil"]);
		});

		it("should box optional arguments into generic T? parameters", async () => {
			expect(
				await runAndCapture(`
					fn orElse<T>(x: T?, fallback: T) -> T {
						if let v = x {
							return v
						}
						return fallback
					}
					let m: Number? = 7
					print(orElse(x: m, fallback: 0))
					let n: Number? = nil
					print(orElse(x: n, fallback: 0))
					let maybes: [Number?] = [nil]
					print(orElse(x: maybes.first, fallback: m))
				`),
			).toEqual(["7", "0", "nil"]);
		});

		it("should eta-convert closures crossing a T? boundary", async () => {
			expect(
				await runAndCapture(`
					fn applyToSome<T>(f: (T?) -> Number, x: T) -> Number {
						return f(x)
					}
					print(applyToSome(f: { v in (v ?? 0) + 1 }, x: 41))
				`),
			).toEqual(["42"]);
		});

		it("should reject arrays of T? crossing a non-optional instantiation", async () => {
			expect(
				await compileErrors(`
					fn compact<T>(xs: [T?]) -> Number {
						return xs.count
					}
					let maybes: [Number?] = [nil]
					print(compact(xs: maybes))
				`),
			).toEqual([
				"Optional type parameters under arrays, dictionaries, or async function types cannot cross this generic boundary yet",
			]);
		});
	});

	describe("host boundary", () => {
		it("should treat a host null as the outermost none (plain convention)", async () => {
			const { host, lines } = makeHost();
			host.registerPackage({
				name: "util",
				declarations: `declare fn pick<T>(xs: Array<T>) -> T?`,
				runtime: {
					pick: (xs: unknown[]) => (xs.length > 0 ? xs[0] : null),
				},
			});
			await host.runSource(`
				let maybes: [Number?] = [nil]
				print(util.pick(xs: maybes))
				let empty: [Number?] = []
				print(util.pick(xs: empty))
				let nums: [Number?] = [3]
				print(util.pick(xs: nums))
			`);
			// Host code cannot express .some(nil): its null is always the
			// outer none, so a nil first element reads as "nil", not
			// "Optional(nil)".
			expect(lines).toEqual(["nil", "nil", "Optional(3)"]);
		});
	});

	describe("generic value types storing T?", () => {
		it("should adapt struct field reads, writes, and methods", async () => {
			expect(
				await runAndCapture(`
					struct Box<T> {
						var value: T?
						fn get() -> T? {
							return self.value
						}
					}
					var bn = Box(value: 5)
					print(bn.value ?? -1)
					bn.value = 8
					print(bn.value ?? -1)
					print(bn.get() ?? -1)
				`),
			).toEqual(["5", "8", "8"]);
		});

		it("should keep nesting for Box<Number?>", async () => {
			expect(
				await runAndCapture(`
					struct Box<T> {
						var value: T?
					}
					var bm: Box<Number?> = Box(value: nil)
					print(bm.value)
					let inner: Number? = nil
					bm.value = inner
					print(bm.value)
				`),
			).toEqual(["nil", "Optional(nil)"]);
		});

		it("should adapt enum associated values across instantiations", async () => {
			expect(
				await runAndCapture(`
					enum Maybe<T> {
						case just(v: T?)
						case empty
					}
					let mj: Maybe<Number> = Maybe.just(v: 3)
					switch mj {
					case .just(let v):
						print(v ?? -1)
					case .empty:
						print("empty")
					}
					let inner: Number? = nil
					let innerBoxed: Number?? = inner
					let mp: Maybe<Number?> = Maybe.just(v: innerBoxed)
					switch mp {
					case .just(let v):
						print(v)
					case .empty:
						print("empty")
					}
				`),
			).toEqual(["3", "Optional(nil)"]);
		});
	});
});
