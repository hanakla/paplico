import { describe, expect, it } from "vitest";
import { parseProgram } from "../syntax/cstToAst";
import { checkProgram } from "./check";

function errors(source: string): string[] {
	const { ast, diagnostics } = parseProgram(source);
	expect(diagnostics).toEqual([]);
	return checkProgram(ast).diagnostics.map((d) => d.message);
}

describe("class and protocol rules", () => {
	describe("initializers", () => {
		it("should require assigning every stored property", () => {
			expect(
				errors(`
					class Point {
						let x: Number
						let y: Number
						init(x: Number) { self.x = x }
					}
				`),
			).toEqual(["'init' must assign every stored property; missing: y"]);
		});

		it("should require super.init when there is a superclass", () => {
			expect(
				errors(`
					class Base { init() { } }
					class Sub: Base {
						init() { }
					}
				`),
			).toEqual(["'init' must call 'super.init(...)'"]);
		});

		it("should reject using self before super.init", () => {
			expect(
				errors(`
					class Base { init() { } }
					class Sub: Base {
						var n: Number
						init() {
							self.n = 1
							super.init()
						}
					}
				`),
			).toEqual(["'self' and 'super' cannot be used before 'super.init(...)'"]);
		});

		it("should allow self-free statements before super.init", () => {
			expect(
				errors(`
					class Base {
						var tag: String
						init(tag: String) { self.tag = tag }
					}
					class Sub: Base {
						var n: Number
						init(n: Number) {
							let doubled = n * 2
							super.init(tag: "sub")
							self.n = doubled
						}
					}
				`),
			).toEqual([]);
		});

		it("should reject assigning let properties outside init", () => {
			expect(
				errors(`
					class Point {
						let x: Number
						init(x: Number) { self.x = x }
						fn move() -> Void { self.x = 1 }
					}
				`),
			).toEqual(["Cannot assign to 'let' property 'x'"]);
		});
	});

	describe("inheritance", () => {
		it("should require the override modifier", () => {
			expect(
				errors(`
					class Base {
						init() { }
						fn speak() -> String { return "a" }
					}
					class Sub: Base {
						init() { super.init() }
						fn speak() -> String { return "b" }
					}
				`),
			).toEqual(["'speak' overrides an inherited method; add 'override'"]);
		});

		it("should reject override without an inherited method", () => {
			expect(
				errors(`
					class Base {
						init() { }
						override fn speak() -> String { return "a" }
					}
				`),
			).toEqual(["'speak' does not override anything"]);
		});

		it("should reject unions of related classes", () => {
			expect(
				errors(`
					class Base { init() { } }
					class Sub: Base {
						init() { super.init() }
					}
					fn f(v: Base | Sub) -> Number { return 0 }
				`),
			).toEqual([
				"Union members 'Base' and 'Sub' cannot be distinguished at runtime",
			]);
		});
	});

	describe("protocols", () => {
		it("should verify conformance", () => {
			expect(
				errors(`
					protocol Drawable {
						fn draw() -> String
					}
					class Blob: Drawable {
						init() { }
					}
				`),
			).toEqual([
				"'Blob' does not satisfy 'Drawable': missing method 'draw() -> String'",
			]);
		});

		it("should reject structs where a protocol is expected", () => {
			expect(
				errors(`
					protocol Drawable { fn draw() -> String }
					struct Dot {
						fn draw() -> String { return "." }
					}
					fn render(d: Drawable) -> String { return d.draw() }
					let s = render(Dot())
				`),
			).toEqual(["Type 'Dot' is not assignable to 'Drawable'"]);
		});

		it("should reject protocols in unions and is-tests", () => {
			expect(
				errors(`
					protocol Drawable { fn draw() -> String }
					fn f(v: Drawable | Number) -> Number { return 0 }
				`),
			).toEqual(["Protocol types cannot be union members"]);
		});
	});

	describe("methods", () => {
		it("should reject mutating class methods", () => {
			expect(
				errors(`
					class Box {
						var v: Number = 0
						init() { }
						mutating fn set(v: Number) -> Void { self.v = v }
					}
				`),
			).toEqual(["'mutating' is only valid on struct/enum methods"]);
		});

		it("should reject mutating struct methods on let receivers", () => {
			expect(
				errors(`
					struct Vec {
						var x: Number
						mutating fn bump() -> Void { self.x += 1 }
					}
					let v = Vec(x: 1)
					v.bump()
				`),
			).toEqual(["Cannot mutate 'v' because it is a 'let' constant"]);
		});

		it("should reject field mutation in non-mutating struct methods", () => {
			expect(
				errors(`
					struct Vec {
						var x: Number
						fn bump() -> Void { self.x += 1 }
					}
				`),
			).toEqual(["Cannot mutate 'self' because it is a 'let' constant"]);
		});
	});
});
