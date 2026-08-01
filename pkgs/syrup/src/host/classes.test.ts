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

describe("classes and protocols end-to-end", () => {
	describe("classes", () => {
		it("should construct with init and dispatch methods with self", async () => {
			expect(
				await runAndCapture(`
					class Counter {
						let name: String
						var count: Number = 0

						init(name: String) {
							self.name = name
						}

						fn bump(by: Number = 1) -> Number {
							self.count += by
							return self.count
						}
					}
					let c = Counter(name: "hits")
					c.bump()
					c.bump(2)
					print("$(c.name): $(c.count)")
				`),
			).toEqual(["hits: 3"]);
		});

		it("should share instances by reference", async () => {
			expect(
				await runAndCapture(`
					class Box { var v: Number; init(v: Number) { self.v = v } }
					let a = Box(v: 1)
					let b = a
					b.v = 99
					print(a.v)
				`),
			).toEqual(["99"]);
		});

		it("should support single inheritance with override and super", async () => {
			expect(
				await runAndCapture(`
					class Animal {
						let name: String
						init(name: String) { self.name = name }
						fn speak() -> String { return "..." }
						fn describe() -> String { return "$(self.name) says $(self.speak())" }
					}
					class Dog: Animal {
						var tricks: Number
						init(name: String, tricks: Number) {
							super.init(name: name)
							self.tricks = tricks
						}
						override fn speak() -> String { return "woof" }
						fn brag() -> String {
							return "$(super.speak()) -> $(self.speak()) ($(self.tricks))"
						}
					}
					let d = Dog(name: "Rex", tricks: 3)
					print(d.describe())
					print(d.brag())
				`),
			).toEqual(["Rex says woof", "... -> woof (3)"]);
		});

		it("should support generic classes", async () => {
			expect(
				await runAndCapture(`
					class Stack<T> {
						var items: [T] = []
						init() { }
						fn push(item: T) -> Void { self.items.append(item) }
						fn pop() -> T? {
							guard self.items.count > 0 else { return nil }
							return self.items.remove(at: self.items.count - 1)
						}
					}
					let s: Stack<String> = Stack()
					s.push("a")
					s.push("b")
					print(s.pop() ?? "none")
					print(s.pop() ?? "none")
					print(s.pop() ?? "none")
				`),
			).toEqual(["b", "a", "none"]);
		});

		it("should narrow class unions with instanceof-backed is", async () => {
			expect(
				await runAndCapture(`
					class Circle { let r: Number; init(r: Number) { self.r = r } }
					class Rect {
						let w: Number
						let h: Number
						init(w: Number, h: Number) { self.w = w; self.h = h }
					}
					fn area(s: Circle | Rect) -> Number {
						if s is Circle {
							return s.r * s.r * 3
						}
						return s.w * s.h
					}
					print(area(Circle(r: 2)))
					print(area(Rect(w: 3, h: 4)))
				`),
			).toEqual(["12", "12"]);
		});
	});

	describe("protocols", () => {
		it("should dispatch through protocol-typed values", async () => {
			expect(
				await runAndCapture(`
					protocol Drawable {
						let name: String
						fn draw() -> String
					}
					class Circle: Drawable {
						let name: String
						init(name: String) { self.name = name }
						fn draw() -> String { return "circle $(self.name)" }
					}
					class Label: Drawable {
						let name: String
						init(name: String) { self.name = name }
						fn draw() -> String { return "label $(self.name)" }
					}
					fn render(items: [Drawable]) -> Void {
						for item in items {
							print(item.draw())
						}
					}
					render([Circle(name: "c1"), Label(name: "t1")])
				`),
			).toEqual(["circle c1", "label t1"]);
		});

		it("should support generic protocols", async () => {
			expect(
				await runAndCapture(`
					protocol Provider<T> {
						fn get() -> T
					}
					class Fixed: Provider<Number> {
						let v: Number
						init(v: Number) { self.v = v }
						fn get() -> Number { return self.v }
					}
					fn readFrom(p: Provider<Number>) -> Number { return p.get() }
					print(readFrom(Fixed(v: 42)))
				`),
			).toEqual(["42"]);
		});

		it("should conform classes to the builtin Error protocol", async () => {
			expect(
				await runAndCapture(`
					class ParseFailure: Error {
						let message: String
						init(message: String) { self.message = message }
					}
					fn describe(error: Error) -> String { return "captured" }
					fn collect(errors: [Error]) -> Number { return errors.count }
					let failure = ParseFailure(message: "bad input")
					print(failure.message)
					print(describe(error: failure))
					print(collect(errors: [failure]))
				`),
			).toEqual(["bad input", "captured", "1"]);
		});
	});

	describe("struct and enum methods", () => {
		it("should dispatch struct methods statically, including mutating", async () => {
			expect(
				await runAndCapture(`
					struct Vec2 {
						var x: Number
						var y: Number

						fn lengthSquared() -> Number {
							return self.x * self.x + self.y * self.y
						}

						mutating fn scale(f: Number) -> Void {
							self.x *= f
							self.y *= f
						}
					}
					var v = Vec2(x: 3, y: 4)
					print(v.lengthSquared())
					v.scale(2)
					print(v.x)
					let copy = v
					v.scale(10)
					print(copy.x)
				`),
			).toEqual(["25", "6", "6"]);
		});

		it("should support enum methods", async () => {
			expect(
				await runAndCapture(`
					enum Shape {
						case circle(radius: Number)
						case dot

						fn area() -> Number {
							switch self {
							case .circle(let r):
								return r * r * 3
							case .dot:
								return 0
							}
						}
					}
					print(Shape.circle(radius: 2).area())
					print(Shape.dot.area())
				`),
			).toEqual(["12", "0"]);
		});
	});

	describe("modules", () => {
		it("should export classes and construct them across modules", async () => {
			const { host, lines } = makeHost();
			host.setModuleResolver((specifier) => {
				if (specifier !== "shapes") return null;
				return `
					export class Circle {
						let r: Number
						init(r: Number) { self.r = r }
						fn area() -> Number { return self.r * self.r * 3 }
					}
					export struct Vec2 {
						var x: Number
						fn doubled() -> Number { return self.x * 2 }
					}
				`;
			});
			await host.runSource(`
				use shapes from "shapes"
				let c = Circle(r: 2)
				print(c.area())
				let v = Vec2(x: 21)
				print(v.doubled())
				let u: Circle | String = c
				print(u is Circle)
			`);
			expect(lines).toEqual(["12", "42", "true"]);
		});
	});
});
