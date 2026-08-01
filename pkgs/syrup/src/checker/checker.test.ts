import { describe, expect, it } from "vitest";
import { parseProgram } from "../syntax/cstToAst";
import {
	type CheckResult,
	checkDeclarations,
	checkProgram,
	type PackageEnv,
} from "./check";

function check(source: string, packages: PackageEnv[] = []): CheckResult {
	const { ast, diagnostics } = parseProgram(source);
	expect(diagnostics).toEqual([]);
	return checkProgram(ast, packages);
}

function errors(source: string, packages: PackageEnv[] = []): string[] {
	return check(source, packages).diagnostics.map((d) => d.message);
}

function makePackage(
	name: string,
	expose: "namespace" | "global",
	declSource: string,
	externalTypes?: Parameters<typeof checkDeclarations>[2],
): PackageEnv {
	const { ast, diagnostics } = parseProgram(declSource);
	expect(diagnostics).toEqual([]);
	const result = checkDeclarations(ast, name, externalTypes);
	expect(result.diagnostics).toEqual([]);
	return { name, expose, members: result.members };
}

const paplicoPkg = () =>
	makePackage(
		"paplico",
		"namespace",
		`
			declare type Layer {
				let name: String
				var opacity: Number
				fn addChild(child: Layer) -> Void
				fn childCount() -> Number
			}
			declare fn addLayer(name: String) -> Layer
			declare fn version() -> String
		`,
	);

const stdPkg = () =>
	makePackage(
		"std",
		"global",
		`
			declare fn print<T>(value: T) -> Void
			declare fn abs(x: Number) -> Number
			declare let pi: Number
		`,
	);

describe("checkProgram", () => {
	describe("inference", () => {
		it("should infer binding types from initializers", () => {
			expect(errors('let x = 1\nlet s = "a"\nlet b = true')).toEqual([]);
		});

		it("should reject reassigning a let", () => {
			expect(errors("let x = 1\nx = 2")).toEqual([
				"Cannot assign to 'let' constant 'x'",
			]);
		});

		it("should allow reassigning a var with the same type", () => {
			expect(errors("var x = 1\nx = 2\nx += 3")).toEqual([]);
		});

		it("should reject assigning a mismatched type", () => {
			expect(errors('var x = 1\nx = "no"')).toEqual([
				"Type 'String' is not assignable to 'Number'",
			]);
		});

		it("should reject unknown identifiers", () => {
			expect(errors("let x = missing")).toEqual([
				"Unknown identifier 'missing'",
			]);
		});
	});

	describe("functions and labels", () => {
		it("should check labeled calls", () => {
			expect(
				errors(`
					fn move(to x: Number, speed: Number = 1) -> Number { return x * speed }
					let a = move(to: 3, speed: 2)
					let b = move(to: 3)
				`),
			).toEqual([]);
		});

		it("should reject an unknown argument label", () => {
			expect(
				errors(`
					fn move(to x: Number) -> Number { return x }
					let a = move(via: 3)
				`),
			).toEqual(["No parameter named 'via:'", "Missing argument for 'to:'"]);
		});

		it("should accept positional and mixed calls (labels are optional)", () => {
			expect(
				errors(`
					fn move(to x: Number, speed: Number = 1) -> Number { return x * speed }
					let a = move(3)
					let b = move(3, 2)
					let c = move(3, speed: 2)
					let d = move(speed: 2, 3)
					let e = move(speed: 2, to: 3)
				`),
			).toEqual([]);
		});

		it("should reject binding one parameter twice", () => {
			expect(
				errors(`
					fn move(to x: Number) -> Number { return x }
					let a = move(3, to: 4)
				`),
			).toEqual(["Extra argument in call"]);
		});

		it("should reject a duplicated label", () => {
			expect(
				errors(`
					fn move(to x: Number, speed: Number = 1) -> Number { return x }
					let a = move(to: 3, to: 4)
				`),
			).toEqual(["Multiple arguments for parameter 'to:'"]);
		});

		it("should reject a missing argument", () => {
			expect(
				errors(`
					fn move(to x: Number) -> Number { return x }
					let a = move()
				`),
			).toEqual(["Missing argument for 'to:'"]);
		});

		it("should report a missing return", () => {
			expect(
				errors(`
					fn f(x: Number) -> Number {
						if x > 0 { return 1 }
					}
				`),
			).toEqual(["Function 'f' is missing a return on some paths"]);
		});

		it("should solve generic functions per call site", () => {
			expect(
				errors(`
					fn firstOr<T>(items: Array<T>, fallback: T) -> T {
						return items.first ?? fallback
					}
					let n = firstOr([1, 2], fallback: 0)
					let s = firstOr(["a"], fallback: "b")
					let bad = firstOr([1], fallback: "x")
				`),
			).toEqual(["Type 'String' is not assignable to 'Number'"]);
		});
	});

	describe("optionals", () => {
		it("should reject nil without an optional context", () => {
			expect(errors("let x = nil")).toEqual([
				"Cannot infer the type of 'nil' here",
			]);
		});

		it("should accept optional bindings and ??", () => {
			expect(
				errors(`
					let maybe: Number? = nil
					let v = maybe ?? 0
					if let m = maybe { let k = m + 1 }
				`),
			).toEqual([]);
		});

		it("should reject if let over a non-optional", () => {
			expect(errors("let n = 1\nif let x = n { }")).toEqual([
				"Optional binding requires an optional value, got 'Number'",
			]);
		});

		it("should require unwrapping before member access", () => {
			const pkg = paplicoPkg();
			expect(
				errors(
					`
						let layer: Layer? = nil
						let n = layer.opacity
					`,
					[pkg],
				),
			).toEqual([
				"Value of optional type 'Layer?' must be unwrapped with '?.', '!', or 'if let'",
			]);
		});

		it("should propagate optionality through ?. chains", () => {
			const pkg = paplicoPkg();
			const result = check(
				`
					let layer: Layer? = nil
					let n = layer?.name.count
					let m = n ?? 0
				`,
				[pkg],
			);
			expect(result.diagnostics).toEqual([]);
		});
	});

	describe("structs", () => {
		it("should construct via memberwise init and access fields", () => {
			expect(
				errors(`
					struct Point { var x: Number; var y: Number }
					var p = Point(x: 1, y: 2)
					p.x = 10
					let d = p.x + p.y
				`),
			).toEqual([]);
		});

		it("should reject mutation through a let binding", () => {
			expect(
				errors(`
					struct Point { var x: Number; var y: Number }
					let p = Point(x: 1, y: 2)
					p.x = 10
				`),
			).toEqual(["Cannot mutate 'p' because it is a 'let' constant"]);
		});

		it("should reject assigning a let property", () => {
			expect(
				errors(`
					struct Point { let x: Number; var y: Number }
					var p = Point(x: 1, y: 2)
					p.x = 10
				`),
			).toEqual(["Cannot assign to 'let' property 'x'"]);
		});

		it("should reject recursive value types", () => {
			expect(errors("struct Node { var next: Node? }")).toEqual([
				"Value type 'Node' cannot recursively contain itself",
			]);
		});

		it("should mark copies for aliasing initializers", () => {
			const result = check(`
				struct Point { var x: Number; var y: Number }
				var a = Point(x: 1, y: 2)
				var b = a
			`);
			expect(result.diagnostics).toEqual([]);
			expect(result.copies.size).toBe(1);
		});
	});

	describe("enums and switch", () => {
		it("should check case construction and exhaustive switch", () => {
			expect(
				errors(`
					enum Shape { case circle(radius: Number); case dot }
					let s = Shape.circle(radius: 5)
					switch s {
					case .circle(let r):
						let a = r * 2
					case .dot:
						let b = 1
					}
				`),
			).toEqual([]);
		});

		it("should report missing cases", () => {
			expect(
				errors(`
					enum Shape { case circle(radius: Number); case dot }
					switch Shape.dot {
					case .dot:
						let b = 1
					}
				`),
			).toEqual(["Switch is not exhaustive; missing cases: circle"]);
		});

		it("should require default for Number switches", () => {
			expect(
				errors(`
					switch 1 {
					case 1:
						let a = 1
					}
				`),
			).toEqual(["Switch requires a 'default' case"]);
		});
	});

	describe("closures", () => {
		it("should infer parameter types from context", () => {
			expect(
				errors(`
					let xs = [1, 2, 3]
					let doubled = xs.map { $0 * 2 }
					let strs = xs.map { n in "v: $(n)" }
					let big = xs.filter { $0 > 1 }
					let total = xs.reduce(0) { acc, n in acc + n }
				`),
			).toEqual([]);
		});

		it("should reject out-of-range shorthand arguments", () => {
			expect(
				errors(`
					let xs = [1, 2]
					let ys = xs.map { $1 * 2 }
				`),
			).toEqual(["Closure only has 1 parameter(s); '$1' is out of range"]);
		});

		it("should reject mutating an array through let", () => {
			expect(
				errors(`
					let xs = [1, 2]
					xs.append(3)
				`),
			).toEqual(["Cannot mutate 'xs' because it is a 'let' constant"]);
		});
	});

	describe("host packages", () => {
		it("should resolve namespace package members and host types", () => {
			const pkg = paplicoPkg();
			expect(
				errors(
					`
						let layer = paplico.addLayer(name: "bg")
						layer.opacity = 0.5
						let n = layer.childCount()
						layer.addChild(paplico.addLayer(name: "child"))
					`,
					[pkg],
				),
			).toEqual([]);
		});

		it("should reject assigning read-only host properties", () => {
			const pkg = paplicoPkg();
			expect(
				errors(
					`
						let layer = paplico.addLayer(name: "bg")
						layer.name = "no"
					`,
					[pkg],
				),
			).toEqual(["Cannot assign to read-only property 'name'"]);
		});

		it("should expose global package members without a prefix", () => {
			expect(
				errors(
					`
						print("hello")
						print(pi)
						let a = abs(0 - 5)
					`,
					[stdPkg()],
				),
			).toEqual([]);
		});

		it("should let user declarations shadow exposed globals", () => {
			expect(
				errors(
					`
						fn abs(x: Number) -> Number { return x }
						let a = abs(1)
					`,
					[stdPkg()],
				),
			).toEqual([]);
		});

		it("should reject declare statements in scripts", () => {
			expect(errors("declare fn f() -> Void")).toEqual([
				"declare is only allowed in host package declarations",
			]);
		});
	});

	describe("loops", () => {
		it("should type range and array loops", () => {
			expect(
				errors(`
					var total = 0
					for i in 0..<10 { total += i }
					for s in ["a", "b"] { total += s.count }
					while total > 100 { break }
				`),
			).toEqual([]);
		});

		it("should reject break outside a loop", () => {
			expect(errors("break")).toEqual(["'break' outside of a loop"]);
		});
	});

	describe("generic constraints", () => {
		const drawable = `
			protocol Drawable { fn draw() -> String }
			class Circle: Drawable {
				init() {}
				fn draw() -> String { return "circle" }
			}
			class Plain { init() {} }
		`;

		it("should allow calling constraint members on the type param", () => {
			expect(
				errors(`${drawable}
					fn render<T: Drawable>(item: T) -> String { return item.draw() }
					let s = render(Circle())
				`),
			).toEqual([]);
		});

		it("should reject arguments that do not satisfy the constraint", () => {
			expect(
				errors(`${drawable}
					fn render<T: Drawable>(item: T) -> String { return item.draw() }
					let s = render(Plain())
				`),
			).toEqual([
				"Type 'Plain' does not satisfy the constraint 'Drawable' of 'T'",
			]);
		});

		it("should reject member access on unconstrained params", () => {
			const messages = errors(`${drawable}
				fn render<T>(item: T) -> String { return item.draw() }
			`);
			expect(messages.length).toBeGreaterThan(0);
		});

		it("should support superclass constraints", () => {
			expect(
				errors(`
					class Animal {
						let name: String
						init(name: String) { self.name = name }
					}
					class Dog: Animal {
						init() { super.init(name: "dog") }
					}
					fn nameOf<T: Animal>(animal: T) -> String { return animal.name }
					let n = nameOf(Dog())
				`),
			).toEqual([]);
		});

		it("should check constraints on generic type declarations", () => {
			expect(
				errors(`${drawable}
					struct Pen<T: Drawable> { let item: T }
					let ok = Pen(item: Circle())
					let bad = Pen(item: Plain())
				`),
			).toEqual([
				"Type 'Plain' does not satisfy the constraint 'Drawable' of 'T'",
			]);
		});

		it("should check constraints on explicit type arguments", () => {
			expect(
				errors(`${drawable}
					struct Pen<T: Drawable> { let item: T }
					let bad: Pen<Number>? = nil
				`),
			).toEqual([
				"Type 'Number' does not satisfy the constraint 'Drawable' of 'T'",
			]);
		});

		it("should pass constrained params into equally-constrained functions", () => {
			expect(
				errors(`${drawable}
					fn render<T: Drawable>(item: T) -> String { return item.draw() }
					fn wrap<U: Drawable>(item: U) -> String { return render(item) }
					let s = wrap(Circle())
				`),
			).toEqual([]);
		});

		it("should reject non-class constraints", () => {
			expect(
				errors(`
					struct Point { let x: Number }
					fn f<T: Point>(v: T) {}
				`),
			).toEqual(["Generic constraints must be class or protocol types"]);
		});
	});

	describe("attributes", () => {
		it("should accept a well-formed @test function", () => {
			expect(errors("@test\nfn works() { let x = 1 }")).toEqual([]);
		});

		it("should reject unknown attributes", () => {
			expect(errors("@wat\nfn works() {}")).toEqual([
				"Unknown attribute '@wat'",
			]);
		});

		it("should reject duplicate @test attributes", () => {
			expect(errors("@test @test\nfn works() {}")).toEqual([
				"Duplicate attribute '@test'",
			]);
		});

		it("should reject @test functions with parameters", () => {
			expect(errors("@test\nfn works(x: Number) {}")).toEqual([
				"'@test' functions take no parameters",
			]);
		});

		it("should reject @test functions returning a value", () => {
			expect(errors("@test\nfn works() -> Number { return 1 }")).toEqual([
				"'@test' functions must not return a value",
			]);
		});

		it("should reject @test on nested functions", () => {
			expect(errors("fn outer() {\n@test\nfn inner() {}\n}")).toEqual([
				"'@test' is only allowed on top-level functions",
			]);
		});

		it("should reject attributes on methods", () => {
			expect(errors("struct S {\nlet x: Number\n@test fn m() {}\n}")).toEqual([
				"Attributes are not allowed on methods",
			]);
		});

		it("should reject @test in modules", () => {
			const { ast, diagnostics } = parseProgram("@test\nfn works() {}");
			expect(diagnostics).toEqual([]);
			const result = checkProgram(ast, [], {
				mode: "module",
				moduleName: "helpers",
			});
			expect(result.diagnostics.map((d) => d.message)).toEqual([
				"'@test' is not allowed in modules",
			]);
		});
	});
});
