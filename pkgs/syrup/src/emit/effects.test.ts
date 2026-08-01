import { describe, expect, it } from "vitest";
import { createScriptHost } from "../host/ScriptHost";

async function compileCode(
	source: string,
	resolver?: (specifier: string) => string | null,
): Promise<string> {
	const host = createScriptHost({ stdout: () => {} });
	if (resolver) host.setModuleResolver(resolver);
	const output = await host.compile(source);
	expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
	return output.code as string;
}

describe("effect analysis (sync downgrade)", () => {
	it("should emit host-free functions as plain sync functions", async () => {
		const code = await compileCode(`
			fn add(a: Number, b: Number) -> Number { return a + b }
			print(add(1, 2))
		`);
		expect(code).toContain("function add(");
		expect(code).not.toContain("async function add(");
		expect(code).not.toContain("await add(");
	});

	it("should keep host-touching functions async and awaited", async () => {
		const code = await compileCode(`
			fn shout(s: String) -> Void { print(s) }
			shout("x")
		`);
		expect(code).toContain("async function shout(");
		expect(code).toContain("(await shout(");
	});

	it("should keep sync recursion sync", async () => {
		const code = await compileCode(`
			fn fact(n: Number) -> Number {
				if n <= 1 { return 1 }
				return n * fact(n - 1)
			}
			print(fact(5))
		`);
		expect(code).toContain("function fact(");
		expect(code).not.toContain("async function fact(");
	});

	it("should use sync HOF helpers for pure closures", async () => {
		const code = await compileCode(`
			let xs = [1, 2, 3].map { $0 * 2 }.filter { $0 > 2 }
			print(xs.count)
		`);
		expect(code).toContain("__arrMapS(");
		expect(code).toContain("__arrFilterS(");
		expect(code).not.toContain("await __arrMap");
	});

	it("should keep HOFs with host-touching closures async", async () => {
		const code = await compileCode(`
			let xs = [1, 2, 3].map { print($0) }
		`);
		expect(code).toContain("(await __arrMap(");
		expect(code).not.toContain("__arrMapS(");
	});

	it("should propagate sync colors across modules", async () => {
		const code = await compileCode(
			`
				use brushes from "brushes"
				print(brushes.double(21))
			`,
			(specifier) =>
				specifier === "brushes"
					? "export fn double(n: Number) -> Number { return n * 2 }"
					: null,
		);
		expect(code).toContain("function double(");
		expect(code).not.toContain("async function double(");
		expect(code).not.toContain('await __mod_brushes["double"]');
	});

	it("should track function-typed parameters across call sites", async () => {
		const code = await compileCode(`
			fn applyTwice(value: Number, transform: (Number) -> Number) -> Number {
				return transform(transform(value))
			}
			let result = applyTwice(3) { $0 + 1 }
			print(result)
		`);
		expect(code).not.toContain("async function applyTwice(");
		expect(code).not.toContain("await transform(");
		expect(code).not.toContain("await applyTwice(");
	});

	it("should track closures and function aliases bound with let", async () => {
		const code = await compileCode(`
			var counter = 0
			let increment = { counter += 1 }
			increment()
			let double = { (n: Number) -> Number in n * 2 }
			let twice = double
			print(double(21) + twice(2))
		`);
		expect(code).not.toContain("await increment(");
		expect(code).not.toContain("await double(");
		expect(code).not.toContain("await twice(");
	});

	it("should await parameter calls when any caller passes an async closure", async () => {
		const code = await compileCode(`
			fn apply(f: (Number) -> Number) -> Number { return f(1) }
			let a = apply { $0 + 1 }
			let b = apply { (n: Number) -> Number in
				print(n)
				return n
			}
			print(a + b)
		`);
		// One async caller pins the parameter slot for every call site.
		expect(code).toContain("async function apply(");
		expect(code).toContain("(await f(");
	});

	it("should chain parameter colors through forwarding functions", async () => {
		const code = await compileCode(`
			fn inner(f: (Number) -> Number) -> Number { return f(1) }
			fn outer(g: (Number) -> Number) -> Number { return inner(g) }
			print(outer { $0 + 1 })
		`);
		expect(code).not.toContain("async function inner(");
		expect(code).not.toContain("async function outer(");
		expect(code).not.toContain("await f(");
		expect(code).not.toContain("await g(");
	});

	it("should stay conservative when a function reference escapes", async () => {
		const code = await compileCode(`
			fn callIt(f: (Number) -> Number) -> Number { return f(1) }
			let box = [callIt]
			print(box.count)
			print(callIt { $0 })
		`);
		// The reference in `box` can reach untracked callers.
		expect(code).toContain("async function callIt(");
		expect(code).toContain("(await f(");
	});

	it("should keep exported function parameters conservative", async () => {
		const code = await compileCode(
			`
				use lib from "lib"
				print(lib.apply(4) { $0 + 1 })
			`,
			(specifier) =>
				specifier === "lib"
					? "export fn apply(n: Number, f: (Number) -> Number) -> Number { return f(n) }"
					: null,
		);
		// The host can call exported functions with arbitrary callbacks.
		expect(code).toContain("async function apply(");
		expect(code).toContain("(await f(");
	});

	it("should emit host-free class methods and inits as sync", async () => {
		const code = await compileCode(`
			class Counter {
				var value: Number
				init(start: Number) { self.value = start }
				fn bump() -> Number {
					self.value = self.value + 1
					return self.value
				}
			}
			let c = Counter(start: 10)
			print(c.bump())
		`);
		expect(code).not.toContain("async __init");
		expect(code).not.toContain("async bump(");
		expect(code).not.toContain("static async __create");
		expect(code).not.toContain("await Counter.__create(");
		expect(code).not.toContain("await c.bump(");
	});

	it("should await base-typed calls when any override is async", async () => {
		const code = await compileCode(`
			class Animal {
				init() {}
				fn speak() -> Number { return 0 }
			}
			class Dog: Animal {
				init() { super.init() }
				override fn speak() -> Number {
					print("woof")
					return 1
				}
			}
			let a: Animal = Dog()
			print(a.speak())
		`);
		// Definitions keep their own colors (awaiting a sync fn is safe)...
		expect(code).toMatch(/\tspeak\(\) \{/);
		expect(code).toContain("async speak()");
		// ...but the base-typed call site must join over the Dog override.
		expect(code).toContain("await a.speak()");
	});

	it("should use exact colors for super calls", async () => {
		const code = await compileCode(`
			class Base {
				init() {}
				fn tag() -> Number { return 1 }
			}
			class Loud: Base {
				init() { super.init() }
				override fn tag() -> Number {
					print("loud")
					return super.tag() + 1
				}
			}
			let l = Loud()
			print(l.tag())
		`);
		// super.tag() targets Base.tag exactly, which is sync.
		expect(code).not.toContain("await super.tag()");
	});

	it("should emit native constructors when the init tree is all-sync", async () => {
		const code = await compileCode(`
			class Animal {
				var kind: String
				init(kind: String) { self.kind = kind }
				fn describe() -> String { return self.kind }
			}
			class Dog: Animal {
				init() { super.init(kind: "dog") }
			}
			let d = Dog()
			print(d.describe())
		`);
		expect(code).toContain("constructor(");
		expect(code).toContain("(new Dog())");
		expect(code).toContain("super(");
		expect(code).not.toContain("__create");
		expect(code).not.toContain("__init");
	});

	it("should keep the __create pattern when any init in the tree awaits", async () => {
		const code = await compileCode(`
			class Logger {
				init() { print("up") }
			}
			class Quiet: Logger {
				var n: Number
				init() {
					super.init()
					self.n = 1
				}
			}
			let q = Quiet()
			print(q.n)
		`);
		// Logger's init awaits, so the whole tree keeps __create/__init.
		expect(code).toContain("static async __create");
		expect(code).toContain("await Quiet.__create(");
		expect(code).not.toContain("constructor(");
	});

	it("should keep init chains async when a parent init touches the host", async () => {
		const chained = await compileCode(`
			class Logger {
				init() { print("logger up") }
			}
			class App: Logger {
				var n: Number
				init() {
					super.init()
					self.n = 1
				}
			}
			let app = App()
			print(app.n)
		`);
		expect(chained).toContain("async __init");
		expect(chained).toContain("await super.__init()");
		expect(chained).toContain("await App.__create(");
	});

	it("should preserve behavior with mixed colors", async () => {
		const lines: string[] = [];
		const host = createScriptHost({ stdout: (text) => lines.push(text) });
		await host.runSource(`
			fn pure(n: Number) -> Number { return n * 2 }
			fn loud(n: Number) -> Number {
				print("loud $(n)")
				return pure(n) + 1
			}
			let xs = [1, 2].map { pure($0) }
			print(xs.reduce(0) { acc, n in acc + n })
			print(loud(10))
		`);
		expect(lines).toEqual(["6", "loud 10", "21"]);
	});
});
