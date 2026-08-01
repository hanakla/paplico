/**
 * Category-based sample scripts covering the Syrup language surface.
 * Pure data: this module must stay free of monaco / DOM dependencies so the
 * samples can be verified from Vitest as well.
 */

/** Initial source of the `brushes` module editor, shared with tests. */
export const BRUSHES_MODULE_SOURCE = `export let baseSize = 12

export fn double(n: Number) -> Number {
	return n * 2
}
`;

export const SAMPLES: { id: string; title: string; source: string }[] = [
	{
		id: "basics",
		title: "Basics: variables & control flow",
		source: `// Variables and arithmetic
let width = 800
var offset = 0
offset += 5
print("width: $(width), offset: $(offset)")

// if / else
let sum = 2 + 3 * 4
if sum > 10 {
	print("$(sum) is large")
} else {
	print("$(sum) is small")
}

// while
var countdown = 3
while countdown > 0 {
	print("countdown: $(countdown)")
	countdown -= 1
}

// for over ranges
for i in 0..<3 {
	print("exclusive: $(i)")
}
for i in 1...3 {
	print("inclusive: $(i)")
}
`,
	},
	{
		id: "optionals",
		title: "Optionals: nil handling",
		source: `// T? holds a value or nil
var maybe: Number? = 42

// if let unwraps for the then-branch
if let v = maybe {
	print("if let: $(v)")
}

// guard let unwraps for the rest of the scope
fn describe(value: Number?) -> String {
	guard let v = value else { return "nothing" }
	return "value $(v)"
}
print(describe(maybe))
print(describe(nil))

// ?? provides a fallback
maybe = nil
print(maybe ?? 0)

// ?. propagates nil through member access
let words = ["syrup"]
print(words.first?.count ?? 0)

// ! force-unwraps (runtime error on nil)
let sure: Number? = 7
print(sure!)
`,
	},
	{
		id: "collections",
		title: "Collections: arrays, dictionaries & strings",
		source: `// Arrays ([T] is sugar for Array<T>)
var nums = [4, 1, 3]
nums.append(2)
print("count: $(nums.count), first: $(nums.first ?? 0)")

let doubled = nums.map { $0 * 2 }
let evens = nums.filter { $0 % 2 == 0 }
let total = nums.reduce(0) { acc, n in acc + n }
let ordered = nums.sorted(by: { a, b in a < b })
print("doubled: $(doubled[0]), evens: $(evens.count), total: $(total)")
print("smallest: $(ordered[0])")

// Dictionaries ([K: V], insertion-ordered; [:] is empty)
var scores = [alice: 3, bob: 5]
scores["carol"] = 1
print("alice: $(scores["alice"] ?? 0)")
for (name, score) in scores {
	print("$(name) has $(score)")
}
print("keys: $(scores.keys.count)")
let removed = scores.removeValue(forKey: "bob")
print("removed: $(removed ?? 0), rest: $(scores.count)")
let empty: [String: Number] = [:]
print("empty dict is empty: $(empty.isEmpty)")

// String members
let title = "Syrup Playground"
print(title.uppercased())
print("has prefix Syrup: $(title.hasPrefix("Syrup"))")
print(title.split(separator: " ")[1])
`,
	},
	{
		id: "types",
		title: "Types: structs, enums & generics",
		source: `// Structs have value semantics: copies are independent
struct Point { var x: Number; var y: Number }
var a = Point(x: 1, y: 2)
var b = a
b.x = 99
print("a.x: $(a.x) (unchanged), b.x: $(b.x)")

// Enums with associated values + exhaustive switch
enum Shape {
	case circle(radius: Number)
	case rect(w: Number, h: Number)
}
let shapes = [Shape.circle(radius: 5), Shape.rect(w: 3, h: 4)]
for shape in shapes {
	switch shape {
	case .circle(let r): print("circle radius $(r)")
	case .rect(let w, let h): print("rect area $(w * h)")
	}
}

// Generic struct (type arguments inferred from the initializer)
struct Pair<A, B> { var first: A; var second: B }
let pair = Pair(first: 1, second: "x")
print("pair: $(pair.first), $(pair.second)")

// Generic enum (type argument from the annotation)
enum Outcome<T> {
	case ok(value: T)
	case err(message: String)
}
let outcome: Outcome<Number> = Outcome.ok(value: 10)
switch outcome {
case .ok(let value): print("ok: $(value)")
case .err(let message): print("err: $(message)")
}

// Generic function
fn firstOr<T>(items: [T], fallback: T) -> T {
	return items.first ?? fallback
}
print(firstOr([7, 8], fallback: 0))
print(firstOr([], fallback: "empty"))

// Generic constraints: T is bounded from above, so the bound's
// members are available and non-conforming arguments are rejected
protocol Drawable { fn draw() -> String }
class Circle: Drawable {
	init() {}
	fn draw() -> String { return "circle" }
}
class Sticker: Drawable {
	init() {}
	fn draw() -> String { return "sticker" }
}
fn render<T: Drawable>(item: T) -> String { return item.draw() }
print("render: $(render(Circle())), $(render(Sticker()))")
// render(5) // compile error: Number does not satisfy Drawable

// Phantom types: Unit never appears in the data, so it costs nothing
// at runtime, but keeps differently-tagged values from mixing
struct Meters {}
struct Pixels {}
struct Length<Unit> { let value: Number }

fn addLengths<Unit>(a: Length<Unit>, b: Length<Unit>) -> Length<Unit> {
	return Length(value: a.value + b.value)
}

let screen: Length<Pixels> = Length(value: 1280)
let margin: Length<Pixels> = Length(value: 16)
print("padded: $(addLengths(screen, margin).value)")

let walk: Length<Meters> = Length(value: 300)
// addLengths(screen, walk) // compile error: Pixels and Meters don't unify
print("walk: $(walk.value)m")
`,
	},
	{
		id: "classes",
		title: "Classes & protocols",
		source: `// Classes have reference semantics: bindings share one instance
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
let counter = Counter(name: "hits")
counter.bump()
let alias = counter
alias.bump(2)
print("$(counter.name): $(counter.count) (changed through alias)")

// Single inheritance with override and super
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
		return "$(super.speak()) -> $(self.speak()) ($(self.tricks) tricks)"
	}
}
let dog = Dog(name: "Rex", tricks: 3)
print(dog.describe())
print(dog.brag())

// Generic class (pop returns T?)
class Stack<T> {
	var items: [T] = []
	init() { }
	fn push(item: T) -> Void { self.items.append(item) }
	fn pop() -> T? {
		guard self.items.count > 0 else { return nil }
		return self.items.remove(at: self.items.count - 1)
	}
}
let stack: Stack<String> = Stack()
stack.push("a")
stack.push("b")
print(stack.pop() ?? "none")
print(stack.pop() ?? "none")
print(stack.pop() ?? "none")

// Protocol-typed values dispatch to the concrete class
protocol Drawable {
	let name: String
	fn draw() -> String
}
class Sprite: Drawable {
	let name: String
	init(name: String) { self.name = name }
	fn draw() -> String { return "sprite $(self.name)" }
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
render([Sprite(name: "s1"), Label(name: "t1")])

// 'is' narrows class unions (instanceof under the hood)
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
print("areas: $(area(Circle(r: 2))), $(area(Rect(w: 3, h: 4)))")

// Structs have methods too; modifying self requires 'mutating'
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
var vec = Vec2(x: 3, y: 4)
vec.scale(2)
print("scaled: $(vec.x), $(vec.y), lengthSquared: $(vec.lengthSquared())")

// Enum methods switch over self
enum Brush {
	case round(radius: Number)
	case flat

	fn width() -> Number {
		switch self {
		case .round(let r):
			return r * 2
		case .flat:
			return 1
		}
	}
}
print("widths: $(Brush.round(radius: 4).width()), $(Brush.flat.width())")
`,
	},
	{
		id: "errors",
		title: "Error handling: throws, do-catch & try",
		source: `// Swift-style error handling. The stdlib ships 'Error', an empty
// marker protocol; conforming classes model error values.
class ParseFailure: Error {
	let message: String
	init(message: String) { self.message = message }
}

// 'throws' marks a function that can throw; thrown values must
// conform to Error.
fn parse(input: String) throws -> Number {
	if input == "bad" {
		throw ParseFailure(message: "unexpected token in $(input)")
	}
	return input.count
}

// Throwing calls must be marked 'try' and handled with do-catch
// (or the caller itself must be declared 'throws').
do {
	print(try parse("hello"))
	print(try parse("bad"))
	print("never reached")
} catch {
	// 'error' is the implicit Error-typed binding, like Swift's
	print("caught an error")
}

// 'throws' propagates: a throwing function forwards errors without
// its own do-catch
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

// do expressions produce a value; with catch they turn errors into
// fallbacks. A single-statement body yields its value implicitly.
fn safeParse(input: String) -> Number {
	return do { try parse(input) } catch { -1 }
}
print("safe: $(safeParse("abcd"))")
print("safe: $(safeParse("bad"))")

// Runtime traps are NOT catchable (Swift semantics): force-unwrapping
// nil or indexing out of range aborts the script even inside do-catch.
`,
	},
	{
		id: "unions",
		title: "Unions, literal types & narrowing",
		source: `// Literal unions: only the listed values are allowed
let align: "left" | "center" | "right" = "center"
switch align {
case "left": print("align: left")
case "center": print("align: center")
case "right": print("align: right")
}

// 'is' narrows a union value in each branch
fn describe(v: String | Number) -> String {
	if v is String {
		return v.uppercased()
	} else {
		return "number $(v * 2)"
	}
}
print(describe("syrup"))
print(describe(21))

// guard-is narrows for the rest of the scope
fn increment(v: String | Number) -> Number {
	guard v is Number else { return 0 }
	return v + 1
}
print("increment: $(increment(41)), skipped: $(increment("nope"))")

// switch with type patterns covers the whole union (no default needed)
fn size(v: String | Number | [Number]) -> Number {
	switch v {
	case is String: return v.count
	case is Number: return v
	case is [Number]: return v.count
	}
}
print("sizes: $(size("abc")), $(size(7)), $(size([1, 2, 3, 4]))")

// != nil narrows an optional to its wrapped type
fn next(v: Number?) -> Number {
	if v != nil {
		return v + 1
	}
	return 0
}
print("next: $(next(41)), $(next(nil))")

// Exhaustive-key dictionaries hold every key, so reads are non-optional
let sides: ["left" | "right": Number] = [left: 1, right: 2]
print("sides total: $(sides["left"] + sides["right"])")

// Computed keys in String-keyed dictionary literals
let key = "accent"
let d = [[key]: 1, base: 2]
print("computed: $(d["accent"] ?? 0), base: $(d["base"] ?? 0)")
`,
	},
	{
		id: "closures",
		title: "Closures & captures",
		source: `// Trailing closure with shorthand arguments
let sizes = [1, 2, 3].map { $0 * 10 }
print("sizes: $(sizes[0]), $(sizes[1]), $(sizes[2])")

// Function-typed parameter + trailing closure at the call site
fn applyTwice(value: Number, transform: (Number) -> Number) -> Number {
	return transform(transform(value))
}
let result = applyTwice(3) { $0 + 1 }
print("applyTwice: $(result)")

// Closure stored in a variable (annotate when there is no context)
let double = { (n: Number) -> Number in n * 2 }
print("double(21) = $(double(21))")

// Closures capture variables by reference
var counter = 0
let increment = { counter += 1 }
increment()
increment()
print("counter: $(counter)")
`,
	},
	{
		id: "async",
		title: "Async & await",
		source: `// Calling an async host function requires await (top-level await is allowed)
let single = await paplico.loadAsset(name: "brush.png")
print("single asset size: $(single)")

// User-defined async fn
async fn preload(names: [String]) -> Number {
	var total = 0
	for name in names {
		total += await paplico.loadAsset(name: name)
	}
	return total
}
let total = await preload(["a.png", "bb.png"])
print("total size: $(total)")
`,
	},
	{
		id: "modules",
		title: "Modules: use/export",
		source: `use brushes from "brushes"
use { double } from "brushes"

// Exported values are reached through the module namespace...
let size = brushes.double(brushes.baseSize)
print("doubled base size: $(size)")

// ...or bound directly with a named use
print("named use: $(double(4))")

let sizes = [1, 2, 3].map { $0 * brushes.baseSize }
print("first size: $(sizes.first ?? 0)")
`,
	},
	{
		id: "tests",
		title: "Tests: @test & expect",
		source: `// @test functions run with the "Run Tests" button.
// A normal Run strips them from the compiled output.
print("Press \\"Run Tests\\" to run the @test functions")

struct Vec2 {
	let x: Number
	let y: Number
	fn plus(other: Vec2) -> Vec2 {
		return Vec2(x: self.x + other.x, y: self.y + other.y)
	}
}

fn clamp01(value: Number) -> Number {
	return min(max(value, 0), 1)
}

@test
fn addsVectors() {
	expect(Vec2(x: 1, y: 2).plus(Vec2(x: 3, y: 4))).toEqual(Vec2(x: 4, y: 6))
}

@test
fn clampsIntoUnitRange() {
	expect(clamp01(1.5)).toEqual(1)
	expect(clamp01(-2)).toEqual(0)
	expect(clamp01(0.25)).toEqual(0.25)
}

@test
fn failsOnPurpose() {
	expect("syrup".count).toEqual(4)
}
`,
	},
	{
		id: "host",
		title: "Host API: paplico",
		source: `// Host API injected as the \`paplico\` namespace
let layer = paplico.addLayer(name: "sketch")
layer.opacity = 0.8

for i in 0..<3 {
	layer.addRect(x: i * 40, y: 0, w: 32, h: 32)
}

print("layer: $(layer.name), opacity: $(layer.opacity)")
print("children: $(layer.childCount())")
`,
	},
];
