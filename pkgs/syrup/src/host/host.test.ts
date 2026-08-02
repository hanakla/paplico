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

describe("ScriptHost end-to-end", () => {
	describe("basics", () => {
		it("should run arithmetic and string interpolation", async () => {
			expect(
				await runAndCapture(`
					let a = 2 + 3 * 4
					print("a is $(a)")
					print(a % 5)
				`),
			).toEqual(["a is 14", "4"]);
		});

		it("should call functions with labels and defaults", async () => {
			expect(
				await runAndCapture(`
					fn move(to x: Number, speed: Number = 10) -> Number {
						return x * speed
					}
					print(move(to: 3))
					print(move(to: 3, speed: 2))
				`),
			).toEqual(["30", "6"]);
		});

		it("should run generic functions", async () => {
			expect(
				await runAndCapture(`
					fn firstOr<T>(items: Array<T>, fallback: T) -> T {
						return items.first ?? fallback
					}
					print(firstOr([7, 8], fallback: 0))
					print(firstOr([], fallback: "empty"))
				`),
			).toEqual(["7", "empty"]);
		});

		it("should use stdlib math functions", async () => {
			expect(
				await runAndCapture(`
					print(abs(0 - 5))
					print(max(min(3, 9), 1))
					print(floor(1.9) + round(0.6))
				`),
			).toEqual(["5", "3", "2"]);
		});
	});

	describe("value semantics", () => {
		it("should copy structs on assignment", async () => {
			expect(
				await runAndCapture(`
					struct Point { var x: Number; var y: Number }
					var a = Point(x: 1, y: 2)
					var b = a
					b.x = 99
					print(a.x)
					print(b.x)
				`),
			).toEqual(["1", "99"]);
		});

		it("should copy nested struct fields recursively", async () => {
			expect(
				await runAndCapture(`
					struct Inner { var v: Number }
					struct Outer { var inner: Inner }
					var a = Outer(inner: Inner(v: 1))
					var b = a
					b.inner.v = 42
					print(a.inner.v)
				`),
			).toEqual(["1"]);
		});

		it("should copy structs passed as arguments", async () => {
			expect(
				await runAndCapture(`
					struct Point { var x: Number; var y: Number }
					fn stomp(p: Point) -> Number {
						var q = p
						q.x = 100
						return q.x
					}
					var a = Point(x: 1, y: 2)
					print(stomp(a))
					print(a.x)
				`),
			).toEqual(["100", "1"]);
		});
	});

	describe("enums and switch", () => {
		it("should construct cases and match with bindings", async () => {
			expect(
				await runAndCapture(`
					enum Shape {
						case circle(radius: Number)
						case rect(w: Number, h: Number)
						case dot
					}
					fn area(s: Shape) -> Number {
						switch s {
						case .circle(let r):
							return r * r * 3
						case .rect(let w, let h):
							return w * h
						case .dot:
							return 0
						}
					}
					print(area(Shape.circle(radius: 2)))
					print(area(Shape.rect(w: 3, h: 4)))
					print(area(Shape.dot))
				`),
			).toEqual(["12", "12", "0"]);
		});

		it("should switch over literals with default", async () => {
			expect(
				await runAndCapture(`
					fn describe(n: Number) -> String {
						switch n {
						case 0:
							return "zero"
						case 1:
							return "one"
						default:
							return "many"
						}
					}
					print(describe(0))
					print(describe(5))
				`),
			).toEqual(["zero", "many"]);
		});
	});

	describe("optionals", () => {
		it("should evaluate ??, if let, and nil comparisons", async () => {
			expect(
				await runAndCapture(`
					var maybe: Number? = nil
					print(maybe ?? 0 - 1)
					if let v = maybe { print(v) } else { print("none") }
					maybe = 5
					print(maybe ?? 0)
					print(maybe == nil)
				`),
			).toEqual(["-1", "none", "5", "false"]);
		});

		it("should run every condition of an if list before the body", async () => {
			expect(
				await runAndCapture(`
					fn describe(text: String?) -> String {
						if let value = text, !value.isEmpty {
							return "got $(value)"
						} else {
							return "empty"
						}
					}
					print(describe(text: "hi"))
					print(describe(text: ""))
					print(describe(text: nil))
				`),
			).toEqual(["got hi", "empty", "empty"]);
		});

		it("should let a guard list bind for the statements that follow", async () => {
			expect(
				await runAndCapture(`
					fn describe(text: String?) -> String {
						guard let value = text, !value.isEmpty else { return "empty" }
						return "got $(value)"
					}
					print(describe(text: "hi"))
					print(describe(text: ""))
					print(describe(text: nil))
				`),
			).toEqual(["got hi", "empty", "empty"]);
		});

		it("should throw on force-unwrapping nil", async () => {
			const { host } = makeHost();
			const output = await host.compile("let x: Number? = nil\nlet y = x!");
			expect(output.code).not.toBeNull();
			await expect(host.run(output.code as string)).rejects.toThrow(
				/force-unwrapping/,
			);
		});
	});

	describe("arrays and strings", () => {
		it("should run array builtins", async () => {
			expect(
				await runAndCapture(`
					var xs = [3, 1, 2]
					xs.append(4)
					print(xs.count)
					print(xs.contains(4))
					print(xs.map { $0 * 10 }.reduce(0) { acc, n in acc + n })
					print(xs.filter { $0 > 1 }.count)
					print(xs.sorted(by: { a, b in a < b })[0])
					print(xs.remove(at: 0))
					print(xs.first ?? 0)
				`),
			).toEqual(["4", "true", "100", "3", "1", "3", "1"]);
		});

		it("should throw on out-of-range subscripts", async () => {
			const { host } = makeHost();
			const output = await host.compile("let xs = [1]\nlet v = xs[5]");
			expect(output.code).not.toBeNull();
			await expect(host.run(output.code as string)).rejects.toThrow(
				/out of range/,
			);
		});

		it("should run string builtins", async () => {
			expect(
				await runAndCapture(`
					let s = "Hello World"
					print(s.count)
					print(s.uppercased())
					print(s.hasPrefix("Hello"))
					print(s.split(separator: " ")[1])
				`),
			).toEqual(["11", "HELLO WORLD", "true", "World"]);
		});
	});

	describe("control flow", () => {
		it("should run loops with break and continue", async () => {
			expect(
				await runAndCapture(`
					var total = 0
					for i in 1...5 {
						if i == 3 { continue }
						if i == 5 { break }
						total += i
					}
					for s in ["a", "bb"] { total += s.count }
					var n = 0
					while n < 3 { n += 1 }
					print(total)
					print(n)
				`),
			).toEqual(["10", "3"]);
		});
	});

	describe("closures", () => {
		it("should capture variables by reference", async () => {
			expect(
				await runAndCapture(`
					var counter = 0
					let bump = { counter += 1 }
					bump()
					bump()
					print(counter)
				`),
			).toEqual(["2"]);
		});

		it("should pass trailing closures to user functions", async () => {
			expect(
				await runAndCapture(`
					fn twice(f: (Number) -> Number) -> Number {
						return f(f(1))
					}
					print(twice { $0 + 10 })
				`),
			).toEqual(["21"]);
		});
	});

	describe("host packages", () => {
		function registerPaplicoMock(host: ScriptHost): {
			calls: unknown[][];
		} {
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
				},
			});
			return { calls };
		}

		it("should call injected functions and methods with erased labels", async () => {
			const { host, lines } = makeHost();
			const { calls } = registerPaplicoMock(host);
			await host.runSource(`
				let bg = paplico.addLayer(name: "bg")
				bg.opacity = 0.5
				bg.addChild(paplico.addLayer(name: "child"))
				print(bg.name)
				print(bg.opacity)
				print(bg.childCount())
			`);
			expect(calls).toEqual([
				["addLayer", "bg"],
				["addLayer", "child"],
			]);
			expect(lines).toEqual(["bg", "0.5", "1"]);
		});

		it("should expose global packages without a prefix", async () => {
			const { host, lines } = makeHost();
			host.registerPackage({
				name: "doc",
				declarations: "declare fn width() -> Number",
				runtime: { width: () => 800 },
				expose: "global",
			});
			await host.runSource("print(width())");
			expect(lines).toEqual(["800"]);
		});

		it("should let callers omit arguments declared with '?'", async () => {
			const { host, lines } = makeHost();
			host.registerPackage({
				name: "ask",
				declarations: `
					declare type Prompt {
						fn string(message: String, defaultValue?: String) -> String
					}
					declare let prompt: Prompt
				`,
				runtime: {
					prompt: {
						string: (message: string, defaultValue = "(none)") =>
							`${message}:${defaultValue}`,
					},
				},
			});
			await host.runSource(`
				print(ask.prompt.string(message: "a"))
				print(ask.prompt.string(message: "b", defaultValue: "given"))
			`);
			expect(lines).toEqual(["a:(none)", "b:given"]);
		});

		it("should reject omittable parameters outside declare", async () => {
			const { host } = makeHost();
			const result = await host.compile(`
				fn greet(name?: String) -> String {
					return name
				}
			`);
			expect(
				result.diagnostics.map((diagnostic) => diagnostic.message),
			).toContain(
				"Omittable parameters are only allowed in declare; write a default value instead",
			);
		});

		it("should reject name collisions at registration time", async () => {
			const { host } = makeHost();
			expect(() =>
				host.registerPackage({
					name: "x",
					declarations: "declare fn print(v: Number) -> Void",
					runtime: { print: () => {} },
					expose: "global",
				}),
			).toThrow(/already taken/);
		});

		it("should normalize undefined host results to nil for optionals", async () => {
			const { host, lines } = makeHost();
			host.registerPackage({
				name: "finder",
				declarations: "declare fn find(key: String) -> String?",
				runtime: { find: () => undefined },
			});
			await host.runSource('print(finder.find("a") ?? "missing")');
			expect(lines).toEqual(["missing"]);
		});
	});

	describe("compile errors", () => {
		it("should return null code with diagnostics", async () => {
			const { host } = makeHost();
			const output = await host.compile('let x: Number = "no"');
			expect(output.code).toBeNull();
			expect(output.diagnostics.length).toBeGreaterThan(0);
		});
	});
});
