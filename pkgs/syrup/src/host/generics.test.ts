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
	const { diagnostics } = await host.compile(source);
	return diagnostics.map((d) => d.message);
}

describe("user-defined generic types", () => {
	describe("generic structs", () => {
		it("should infer type arguments from the memberwise init", async () => {
			expect(
				await runAndCapture(`
					struct Box<T> { let value: T }
					let a = Box(value: 42)
					let b = Box(value: "hi")
					print(a.value + 1)
					print(b.value.count)
				`),
			).toEqual(["43", "2"]);
		});

		it("should call methods whose signatures use the type parameter", async () => {
			expect(
				await runAndCapture(`
					struct Pair<T> {
						let first: T
						let second: T
						fn swapped() -> Pair<T> {
							return Pair(first: self.second, second: self.first)
						}
					}
					let p = Pair(first: 1, second: 2).swapped()
					print("$(p.first), $(p.second)")
				`),
			).toEqual(["2, 1"]);
		});

		it("should accept explicit generic annotations", async () => {
			expect(
				await runAndCapture(`
					struct Box<T> { let value: T }
					let boxes: Array<Box<Number>> = [Box(value: 1), Box(value: 2)]
					let total = boxes.reduce(0) { acc, box in acc + box.value }
					print(total)
				`),
			).toEqual(["3"]);
		});

		it("should reject mismatched type arguments", async () => {
			const messages = await compileErrors(`
				struct Box<T> { let value: T }
				let wrong: Box<String> = Box(value: 1)
			`);
			expect(messages.length).toBeGreaterThan(0);
		});

		it("should reject wrong type argument arity", async () => {
			const messages = await compileErrors(`
				struct Box<T> { let value: T }
				let wrong: Box<Number, String> = Box(value: 1)
			`);
			expect(messages.length).toBeGreaterThan(0);
		});

		it("should flow through generic functions", async () => {
			expect(
				await runAndCapture(`
					struct Box<T> { let value: T }
					fn unwrap<T>(box: Box<T>) -> T { return box.value }
					print(unwrap(Box(value: 9)) * 2)
					print(unwrap(Box(value: "syrup")).count)
				`),
			).toEqual(["18", "5"]);
		});
	});

	describe("generic structs with mutation", () => {
		it("should run mutating methods against inferred type arguments", async () => {
			expect(
				await runAndCapture(`
					struct Stack<T> {
						var items: Array<T>
						mutating fn push(item: T) { self.items.append(item) }
						fn peek() -> T? { return self.items.last }
					}
					var s = Stack(items: [1, 2])
					s.push(item: 3)
					print(s.peek() ?? 0)
					print(s.items.count)
				`),
			).toEqual(["3", "3"]);
		});
	});

	describe("generic enums", () => {
		it("should infer type arguments from case payloads and match them", async () => {
			expect(
				await runAndCapture(`
					enum Maybe<T> {
						case some(v: T)
						case none
					}
					fn describe(m: Maybe<Number>) -> String {
						switch m {
						case .some(let v): return "some $(v)"
						case .none: return "none"
						}
					}
					print(describe(Maybe.some(v: 4)))
					print(describe(Maybe.none))
				`),
			).toEqual(["some 4", "none"]);
		});
	});

	describe("generic constraints", () => {
		it("should dispatch protocol members through a constrained param", async () => {
			expect(
				await runAndCapture(`
					protocol Speaker { fn speak() -> String }
					class Dog: Speaker {
						init() {}
						fn speak() -> String { return "woof" }
					}
					class Cat: Speaker {
						init() {}
						fn speak() -> String { return "meow" }
					}
					fn shout<T: Speaker>(animal: T) -> String {
						return animal.speak().uppercased()
					}
					print(shout(Dog()))
					print(shout(Cat()))
				`),
			).toEqual(["WOOF", "MEOW"]);
		});

		it("should read and write superclass fields through a constrained param", async () => {
			expect(
				await runAndCapture(`
					class Counter {
						var count: Number
						init(count: Number) { self.count = count }
					}
					class StepCounter: Counter {
						init() { super.init(count: 10) }
					}
					fn bump<T: Counter>(counter: T) -> Number {
						counter.count += 1
						return counter.count
					}
					print(bump(StepCounter()))
				`),
			).toEqual(["11"]);
		});
	});

	describe("phantom type parameters", () => {
		it("should tag values with a parameter that has no runtime data", async () => {
			expect(
				await runAndCapture(`
					struct Meters {}
					struct Pixels {}
					struct Length<Unit> { let value: Number }
					fn addLengths<Unit>(a: Length<Unit>, b: Length<Unit>) -> Length<Unit> {
						return Length(value: a.value + b.value)
					}
					let screen: Length<Pixels> = Length(value: 1280)
					let margin: Length<Pixels> = Length(value: 16)
					print(addLengths(screen, margin).value)
				`),
			).toEqual(["1296"]);
		});

		it("should reject mixing values with different phantom tags", async () => {
			const messages = await compileErrors(`
				struct Meters {}
				struct Pixels {}
				struct Length<Unit> { let value: Number }
				fn addLengths<Unit>(a: Length<Unit>, b: Length<Unit>) -> Length<Unit> {
					return Length(value: a.value + b.value)
				}
				let px: Length<Pixels> = Length(value: 1)
				let m: Length<Meters> = Length(value: 2)
				let bad = addLengths(px, m)
			`);
			expect(messages.length).toBeGreaterThan(0);
		});

		it("should drop never-constructed tag structs from the output", async () => {
			const { host } = makeHost();
			const { code } = await host.compile(`
				struct Meters {}
				struct Length<Unit> { let value: Number }
				let walk: Length<Meters> = Length(value: 300)
				print(walk.value)
			`);
			expect(code).not.toBeNull();
			expect(code).not.toContain("class Meters");
			expect(code).toContain("class Length");
		});

		it("should keep empty structs that are constructed", async () => {
			const { host } = makeHost();
			const { code } = await host.compile(`
				struct Unit {}
				let u = Unit()
				print("made")
			`);
			expect(code).toContain("class Unit");
		});

		it("should keep empty structs discriminated in unions", async () => {
			const { host } = makeHost();
			const { code } = await host.compile(`
				struct Tag {}
				fn check(x: Tag | Number) -> Bool { return x is Tag }
				print("ok")
			`);
			expect(code).not.toBeNull();
			expect(code).toContain("class Tag");
		});
	});

	describe("generic classes", () => {
		it("should infer type arguments from init and dispatch methods", async () => {
			expect(
				await runAndCapture(`
					class Holder<T> {
						var item: T
						init(item: T) { self.item = item }
						fn get() -> T { return self.item }
						fn replace(with next: T) { self.item = next }
					}
					let h = Holder(item: 5)
					h.replace(with: 8)
					print(h.get() * 2)
				`),
			).toEqual(["16"]);
		});

		it("should support inheriting from an instantiated generic superclass", async () => {
			expect(
				await runAndCapture(`
					class Source<T> {
						var value: T
						init(value: T) { self.value = value }
						fn read() -> T { return self.value }
					}
					class NumberSource: Source<Number> {
						init() { super.init(value: 42) }
					}
					print(NumberSource().read() + 1)
				`),
			).toEqual(["43"]);
		});
	});
});
