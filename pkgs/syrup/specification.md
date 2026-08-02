# Syrup Language Specification

Syrup is a statically typed, lightweight scripting language for describing
Paplico automations. It has a Swift-like syntax and compiles to plain
JavaScript. The language core knows nothing about Paplico: all host APIs are
injected from outside as typed declarations plus runtime bindings.

- File extension: `.syrup`
- Package: `@paplico/syrup` (directory `pkgs/syrup`)
- Monaco language ID: `syrup`

```swift
let layer = paplico.addLayer(name: "bg")

for i in 0..<20 {
	layer.addRect(x: i * 40, y: 0, w: 2, h: 600)
}

let doubled = [1, 2, 3].map { $0 * 2 }
print("count: $(doubled.count)")
```

## 1. Lexical structure

- **Comments**: `// line` and `/* block */` (block comments do not nest).
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`.
- **Keywords**: `let var fn struct enum class protocol case default if else
  for in is while return break continue switch nil true false declare use
  from export async await guard super do try catch throw throws`.
  `type` is contextual (only special after `declare`) and remains usable as an
  identifier. `use` and `from` are still accepted as argument labels and
  external parameter labels (`move(from: a)`). `init` and `override` are contextual too (special only inside
  class bodies), and `self` is not a keyword but a reserved implicit binding
  inside methods and initializers (see "Classes").
- **Number literals**: decimal with optional fraction and exponent; `_` may be
  used as a digit separator (`1_000_000`, `0.5`, `1e3`).
- **String literals**: double-quoted, single-line. Escapes: `\n \t \r \0 \\ \"
  \' \$`. Interpolation: `$(expression)`; nested strings inside interpolations
  are allowed. A `$` not followed by `(` is literal text; write `\$(` for a
  literal `$(`.
- **Attributes**: `@name` before a `fn` declaration (see "Attributes").
- **Statement termination**: statements are terminated by layout; `;` is
  allowed as an optional separator. Note (current limitation): a line
  beginning with `-`, `(`, `[`, or `{` may be parsed as a continuation of the
  previous expression, similar to JavaScript ASI hazards. Use `;` to force a
  boundary.

## 2. Types

| Type | Meaning | JS representation |
| --- | --- | --- |
| `Number` | The single numeric type | `number` |
| `String` | Text | `string` |
| `Bool` | Boolean | `boolean` |
| `Void` (or `()`) | No value | `undefined` |
| `Array<T>` (= `[T]`) | Ordered collection | `Array` |
| `Dictionary<K, V>` (= `[K: V]`, `Record<K, V>`) | Insertion-ordered key-value map | `Map` |
| `T?` (= `Optional<T>`) | Value or `nil` | value or `null`; nested optionals box the some-case as `{$some: value}` (see "Optionals") |
| `A \| B` (union) | One of the member types | the member's representation |
| `"left"` / `1` / `true` (literal types) | Exactly that value | base type's representation |
| `(A, B) -> R` | Function type | function |
| struct types | Nominal value types | JS class instance (copied at value-semantics boundaries) |
| enum types | Nominal sum types | tagged object `{ $case, ... }` |
| class types | Nominal reference types | JS class instance |
| protocol types | Nominal protocols | the conforming class instance |
| host types (`declare type`) | Opaque host objects | host object |

There is no `Int`/`Double` split. Tuples are not supported. `[T]` is sugar
for `Array<T>`; `[K: V]` and `Record<K, V>` are alternate spellings of
`Dictionary<K, V>`. Structs, enums, classes, and protocols may declare
their own generic parameters (see "Declarations").

### Optionals

- `T?` is sugar for `Optional<T>`. Optionals nest, like Swift's: `T??`
  (also `Optional<Optional<T>>`) keeps `.some(nil)` — "a value that is
  nil" — distinct from `nil` — "no value". Nested optionals arise from
  generic instantiation (`[Number?].first` is `Number??`, and so is a
  `[String: Number?]` subscript read) and can be written directly in
  annotations.
- `nil` is only valid where an optional type is expected, and always
  denotes the outermost none.
- `a ?? b : (T?, T) -> T` (right-associative) unwraps exactly one level:
  for `xs: [Number?]`, `xs.first ?? 9` is `Number?` — it yields `9` only
  when the array is empty, and `nil` when the first element is nil.
- `a?.member` propagates `nil` and flattens: chaining never produces a
  nested optional (Swift behaves the same).
- `a!` force-unwraps one level and throws a runtime error on the
  outermost none.
- `if let x = opt { ... }` binds one unwrapped level in the then-branch
  (`if let v = xs.first` succeeds with `v = nil` when the first element
  is nil).
- `guard let x = opt else { ... }` binds the unwrapped value for the rest of
  the enclosing scope (see "Statements").
- `x == nil` / `x != nil` compare the outermost level and narrow a plain
  optional in the surrounding control flow (see "Flow-sensitive
  narrowing"). Nested optionals and `T?` over a type parameter do not
  narrow — unwrap with `if let` instead.

#### Nested-optional runtime representation

A plain optional (`Number?`) is represented as the value or `null`. A
*nested* optional (`T??` and deeper) and an optional of a type parameter
(`T?` inside generic code) box their some-case as `{$some: value}`, so
`.some(nil)` stays distinct from `null`. Like the `$case` tag on enum
values, the `$some` key is a representation convention. Consequences:

- Arrays and dictionaries store optional elements/values plainly; the box
  appears only at the reading edge (`first`, `last`, non-exhaustive
  dictionary subscripts, `removeValue`).
- `print` and string interpolation render boxed values Swift-style:
  `Optional(3)`, `Optional(nil)`; the outer none prints `nil`. A plain
  optional's value still prints bare.
- Inside a generic function and inside a generic type's members, `T?`
  always uses the boxed form so a single compiled body works for every
  `T`; the compiler inserts lossless one-box conversions where such a
  position meets concrete code that instantiated `T` with a non-optional
  type.
- Host (`declare`) boundaries always use plain values: host code cannot
  produce or observe `.some(nil)`, and a `null` returned from a host
  function is always the outermost none.
- Limitation: a generic signature position like `[T?]` or `[K: T?]`
  cannot cross a call boundary when `T` is instantiated with a
  non-optional type — arrays and dictionaries alias, so their elements
  cannot be rewritten at the boundary. The checker reports this as a
  compile error. `[T]` instantiated with an optional element type is
  fine (elements are opaque to the generic body).

### Literal types and unions

```swift
let align: "left" | "center" | "right" = "center"
var id: Number | String = 1
id = "x"
```

- A literal type (`"left"`, `1`, `true`) is inhabited by exactly that
  value. A literal expression takes a literal type only when the expected
  type is a literal or union type; everywhere else it widens to its base
  type (`String`, `Number`, `Bool`).
- `A | B` is a union type. `|` binds more loosely than `?`, and an optional
  cannot be a union member: `Number | String?` means `Number | (String?)`
  and is rejected — make the whole union optional instead
  (`(Number | String)?`).
- **Runtime discriminability**: every union member must fall into a
  distinct discrimination class — number, string, bool, array, dictionary,
  function, enum, class, or plain object (struct / host type). Literal
  members that share a base type may coexist (they are discriminated by
  value), but two structs, or a struct and a host type, cannot appear in
  the same union (compile error). Classes are discriminated by
  `instanceof`, so a union of classes (`Circle | Rect`) is legal — unless
  the two classes are in an inheritance relationship, which makes them
  indistinguishable and is a compile error. Protocol types cannot be
  union members (see "Protocols"). A literal member alongside its own
  base type collapses into the base type.
- `==` / `!=` work on literal-typed values and on unions composed of
  primitive members.
- A union-typed value is narrowed to a member with `is` and control flow
  (see "Type tests (`is`)" and "Flow-sensitive narrowing"). There is no
  `as` cast.

### Dictionaries

```swift
var scores = [alice: 3, "bob-x": 5]      // [String: Number]
var empty: [String: Number] = [:]
let a = scores["alice"]                  // Number? — nil when the key is absent
scores["carol"] = 1                      // insert or overwrite

let field = "dynamic"
let tagged = [[field]: 1]                // computed key
```

- The type is written `[String: Number]` (Swift style),
  `Record<String, Number>`, or `Dictionary<String, Number>` — all
  equivalent (`Record<K, V>` is an alias for `Dictionary<K, V>`).
- A bracket literal is a dictionary when its first element is a
  `key: value` entry, and an array otherwise. Literal keys are bare
  identifiers (sugar for string keys), string literals (`"bob-x"`), or
  computed `[expr]` keys. Computed keys are only allowed in
  `String`-keyed dictionaries.
- The empty literal is `[:]` (Swift style) and requires an expected
  dictionary type to fix `K`/`V`; `{}` is always an empty closure.
- Keys are `String` or a string-literal union (see "Exhaustive-key
  dictionaries"). Entries keep insertion order.
- Reading through a subscript of a `String`-keyed dictionary returns `V?`,
  as in Swift. Writing assigns a plain `V`; compound assignment through a
  dictionary subscript (`d["k"] += 1`) is not supported.
- Iteration: `for (key, value) in dict` (see "Statements"). Members: see
  "Standard library".
- The runtime representation is a JS `Map` (this avoids prototype pollution
  through user-controlled keys). Dictionaries currently have reference
  semantics, like `Array` (current limitation).

### Exhaustive-key dictionaries

```swift
var margins: ["left" | "right": Number] = [left: 4, right: 8]
let l = margins["left"]                  // Number — not Optional
```

A dictionary keyed by a string-literal union guarantees that every key is
present:

- A literal must supply **all** keys of the union; a missing, duplicated,
  or out-of-union key is a compile error. Computed `[expr]` keys are not
  allowed.
- Subscript reads return a plain `V` (non-optional), because absence is
  impossible.
- `removeValue(forKey:)` is not available (it would break the guarantee).

## 3. Declarations

### `let` / `var`

```swift
let width = 800            // type inferred (Number)
var offset: Number = 0     // annotation optional, initializer required
```

`let` bindings cannot be reassigned. Initializers are mandatory.

### Functions

```swift
fn move(to point: Point, speed: Number, flag: Bool = true) -> Bool { ... }
move(to: p, 1.5)
```

- Parameters have Swift-style external labels: `to point:` (external `to`,
  internal `point`), `name:` (label = name). The Swift `_ name:` no-label
  form has been removed — labels are optional at call sites anyway, so
  every parameter simply has a label.
- **Labels are optional at call sites** and may mix with positional
  arguments: labeled arguments bind to their parameter by name first, then
  positional arguments fill the leftmost unbound parameters in order.
  `move(to: p, speed: 2)`, `move(p, 2)`, `move(p, speed: 2)`, and
  `move(speed: 2, p)` are all the same call. Binding a parameter twice
  (`move(to: p, to: q)`) is a compile error. Labels are resolved at compile
  time and erased in the generated JS (positional arguments) —
  consequently, **arguments are evaluated in parameter order**, not in
  written order, when labels reorder them.
- Skipping a defaulted parameter that sits before another argument's
  parameter requires labels (`move(speed: 2)` works only because `to` has
  no default here — a purely positional call cannot skip earlier defaulted
  parameters).
- Default parameter values are supported.
- Generic functions: `fn firstOr<T>(items: Array<T>, fallback: T) -> T`.
  Type arguments are always inferred at call sites (no explicit `f<T>(...)`).
- Generic constraints: `<T: SomeClass>` / `<T: SomeProtocol>` give a type
  parameter an upper bound. Values of type `T` then expose the bound's
  members (`item.draw()` dispatches dynamically), and every solved type
  argument is checked against the bound at call sites, initializers, and
  explicit type arguments (`Pen<Number>` errors when `T: Drawable`).
  A constrained param satisfies another param's constraint when its own
  bound does. Constraints may only name class or protocol types, and the
  same syntax works on functions, methods, and generic
  struct/enum/class/protocol/`declare type` declarations.
- `async fn` declares an asynchronous function; its calls must be awaited
  (see "Async functions and `await`").
- `fn f() throws -> T` declares a throwing function; its calls must be
  marked `try` and handled (see "Error handling").
- Parameter and return types must be annotated. Omitted return type means
  `Void`.

### Structs

```swift
struct Point {
	var x: Number
	var y: Number

	fn magnitude() -> Number {
		return sqrt(self.x * self.x + self.y * self.y)
	}

	mutating fn moveBy(dx: Number, dy: Number) {
		self.x = self.x + dx
		self.y = self.y + dy
	}
}
var p = Point(x: 1, y: 2)
p.moveBy(dx: 1, dy: 0)                   // mutating: requires a var receiver

struct Pair<A, B> { var first: A; var second: B }
let pair = Pair(first: 1, second: "x")               // Pair<Number, String>
let annotated: Pair<Number, String> = Pair(first: 1, second: "x")
```

- Structs have stored properties plus an implicit memberwise initializer
  (labels = field names, in declaration order).
- Structs may declare `fn` methods. A method that assigns to the struct's
  own fields must be marked `mutating fn`, and a mutating method can only
  be called on a `var` receiver (calling it through a `let` binding is a
  compile error). Methods are dispatched statically and emitted as free
  functions; value semantics are unchanged.
- Structs may declare generic parameters (`struct Pair<A, B>`). Type
  arguments at construction are inferred by unification from the initializer
  arguments; when they cannot be inferred that way, they are taken from the
  expected type annotation, and otherwise construction is a compile error.
  Explicit type arguments appear only in type annotations
  (`Pair<Number, String>`), never at the construction site.
- **Value semantics** (matches Swift): assignment, argument passing, and
  returning an lvalue copy the value; struct/enum-typed fields are copied
  recursively. Copy helpers for generic types are generated per
  instantiation. Exception (current limitation): `Array`, `Dictionary`, and
  host-object fields are copied by reference.
- Mutability is checked statically, as in Swift: properties of a struct held
  in a `let` binding cannot be assigned; `let` properties can never be
  assigned.

### Enums

```swift
enum Shape {
	case circle(radius: Number)
	case rect(w: Number, h: Number)

	fn area() -> Number {
		switch self {
		case .circle(let r): return pi * r * r
		case .rect(let w, let h): return w * h
		}
	}
}
let s = Shape.circle(radius: 5)
let area = s.area()

enum Result<T> {
	case ok(value: T)
	case err(message: String)
}
let ok = Result.ok(value: 5)                         // Result<Number>
let err: Result<Number> = Result.err(message: "boom")
```

- Cases may carry labeled associated values. Construction goes through the
  type name (`Shape.circle(radius: 5)`); bare `.circle(...)` expressions are
  not yet supported. Enums are value types like structs.
- Enums may declare generic parameters. When a case payload does not mention
  a type parameter (like `Result.err` above), the type arguments are inferred
  from the expected type annotation; without one, construction is a compile
  error.
- Enums may declare `fn` methods, which typically `switch self` over the
  cases. Enum methods cannot be `mutating`. Like struct methods, they are
  dispatched statically and emitted as free functions.

### Classes

```swift
class Animal {
	let name: String
	var energy: Number = 100

	init(name: String) {
		self.name = name
	}

	fn describe() -> String { return "$(self.name): $(self.energy)" }
}

class Dog: Animal {
	var tricks: Array<String>

	init(name: String, tricks: Array<String>) {
		self.tricks = tricks
		super.init(name: name)
	}

	override fn describe() -> String {
		return super.describe() + " (dog)"
	}
}

let dog = Dog(name: "Rex", tricks: ["sit"])

class Stack<T> {
	var items: Array<T> = []

	init() {}

	fn push(item: T) { self.items.append(item) }
}
let stack: Stack<Number> = Stack()       // type argument from the annotation
stack.push(1)
```

- A class body contains stored properties (`let` / `var`, optionally with a
  default value: `var x: Number = 0`), exactly one `init(...)` — a class
  must declare precisely one initializer — `fn` methods, and `async fn`
  methods (their calls must be awaited, as usual). Classes may declare
  generic parameters (`class Stack<T>`).
- **Reference semantics**: assignment and argument passing share the same
  instance — mutations are visible through every reference (in contrast to
  structs, which copy).
- `self` is bound implicitly inside methods and `init`. It is not a keyword
  but a reserved binding: declaring another `self` inside a method is a
  compile error.
- Construction uses the class name with the `init`'s labels:
  `Dog(name: "Rex", tricks: ["sit"])`. For generic classes, type arguments
  are inferred from the constructor arguments or from the expected type
  annotation.
- **Single inheritance**: `class Dog: Animal`. Overriding a superclass
  method requires `override fn`; redefining a superclass method without
  `override`, or writing `override` with no matching superclass method, are
  both compile errors. An override's signature must match the superclass
  method exactly.
- `super.method(...)` calls the superclass implementation and
  `super.init(...)` chains initializers. Only the method-call form exists;
  `super.property` access is not supported.
- **Definite initialization**: every stored property without a default value
  must be assigned as a top-level `self.x = ...` statement in the `init`
  body. If the class has a superclass, the `init` must also call
  `super.init(...)`.
- **Initializer order**: in a subclass `init`, `self` and `super` cannot be
  used before the `super.init(...)` call. This follows JS native
  constructor semantics (`super()` must run before any `this` access) and
  is the reverse of Swift's ordering rule; statements that don't touch
  `self` (locals, computing `super.init` arguments) may precede it.
- A `let` property can only be assigned through `self.x` inside the
  declaring class's own `init`.
- `mutating` cannot appear on class methods (it is a struct concept).
- **Unions**: classes are discriminated by `instanceof`, so a union like
  `Circle | Rect` is legal and narrows with `is` / `case is`. A union whose
  members include two classes in an inheritance relationship is a compile
  error (the members cannot be told apart at runtime).
- **Worker boundary**: class instances cannot be passed to host functions in
  Worker mode; doing so is a runtime error ("Class instances cannot cross
  the worker boundary"), because structured cloning would strip the
  prototype (see "Execution and sandboxing").
- Generated JS: a class compiles to a JS `class` with a **native
  `constructor`** when every `init` in its inheritance tree is synchronous
  (the common case). If any `init` in the tree awaits (directly or
  transitively), the whole tree falls back to a `static __create` +
  `__init` pattern so that `init` bodies can `await` (see "Compilation to
  JavaScript").

### Protocols

```swift
protocol Drawable {
	let name: String
	fn draw() -> String
}

class Circle: Drawable {
	let name: String

	init(name: String) {
		self.name = name
	}

	fn draw() -> String { return "circle $(self.name)" }
}

let d: Drawable = Circle(name: "c1")
print(d.draw())                          // dynamically dispatched
```

- A protocol declares property requirements (`let` / `var` with a type)
  and method signatures. Protocols may declare generic parameters
  (`protocol Provider<T>`).
- Conformance is **nominal**: a class conforms only by naming the protocol
  in its declaration (`class Circle: Drawable`); there is no structural
  conformance. Conformance is checked at the class declaration: every
  required member must exist with the exact same type, and a `var`
  requirement must be satisfied by a `var` property.
- Only instances of conforming **classes** can be assigned to a
  protocol-typed value. Structs cannot, even though structs can declare
  methods — a struct value is plain data at runtime and carries no methods
  (struct conformance via witness tables is planned).
- Member and method access through a protocol-typed value is dynamically
  dispatched.
- Restrictions: protocols cannot be union members, cannot be the target of
  `is` (they are not runtime-discriminable), cannot be constructed, and
  cannot inherit from other protocols.
- The standard library declares `Error`, an empty marker protocol
  (Swift's `Error`): classes conform with `class ParseFailure: Error` and
  their instances flow into `Error`-typed slots. It is the designated
  bound for error values once `throws` / `do`-`catch` land.

### Attributes

```swift
@test
fn movesPointByOffset() {
	expect(shift(Point(x: 1, y: 2), by: 10)).toEqual(Point(x: 11, y: 12))
}
```

Attributes are `@name` markers written before a `fn` declaration (they may
combine with `async`). The set of attributes is fixed by the compiler;
unknown names are a compile error. Attributes are not allowed on methods.

The only attribute today is `@test`, which marks a function as a test (see
"Testing"). A `@test` function must be a top-level function with no
parameters, no generic parameters, and no return value, and may not appear
in modules (only in the entry script).

### Error handling

```swift
class ParseFailure: Error {
	let message: String
	init(message: String) { self.message = message }
}

fn parse(input: String) throws -> Number {
	if input == "bad" {
		throw ParseFailure(message: "unexpected token")
	}
	return input.count
}

do {
	print(try parse("hello"))
} catch {
	print("failed")          // the implicit `error: Error` is bound here
}
```

- `fn ... throws` marks a function or method that may throw. `throw expr`
  throws a value; it must conform to the stdlib `Error` protocol (see
  "Protocols").
- Calls to throwing functions must be marked with `try`, and every
  throwing action (`throw` or a `try` call) must be handled: inside a
  `do` body, inside a `throws` function (the error propagates to the
  caller), or at the script top level (an uncaught error aborts the run).
  Closures cannot throw, so throwing calls inside closure bodies are
  rejected.
- `do { ... } catch { ... }` runs the body and, when a thrown error
  escapes it, runs the catch body with the implicit constant `error`
  (typed `Error`) bound to the thrown value. There is exactly one
  catch-all clause — no typed catches or catch patterns (and protocol
  types cannot be tested with `is`, so errors are not discriminable yet).
- `try` is a prefix expression marker and composes with `await` as
  `try await f()`. A `try` whose operand contains no throwing call is a
  compile error.
- The expression form `let a = do { try f() } catch { fallback }`
  produces a value from either body (see "`do` expressions").
- **Runtime traps are not catchable** (Swift semantics): force-unwrap of
  `nil`, out-of-range subscripts, and exceptions raised by host functions
  or `expect` matchers pass through `catch` untouched and abort the
  script (the `@test` harness still reports them per test).
- Not yet supported: typed `throws(E)`, throwing closures and
  function-typed values, `declare fn ... throws` host functions, and
  `try?` / `try!`.

## 4. Expressions

Operator precedence, loosest to tightest:

1. `a ? b : c` (ternary, right-assoc)
2. `??` (right-assoc)
3. `||`
4. `&&`
5. `==` `!=` (non-chaining)
6. `<` `<=` `>` `>=` (non-chaining)
7. `+` `-`
8. `*` `/` `%`
9. `is` (type test)
10. prefix `!` `-` `await` `try`
11. postfix: call `f(x)`, trailing closure, member `.x`, optional chain
    `?.x`, subscript `[i]`, force unwrap `!`

- `+` works on `Number + Number` and `String + String` (concatenation).
- `==`/`!=` work on `Number`, `String`, `Bool`, optional-vs-`nil`
  comparisons, literal-typed values, and unions composed of primitives.
  Struct equality is not yet supported.
- Comparisons work on `Number` and `String`.
- Ranges `a..<b` / `a...b` exist only in `for`-`in` headers (not values).
- `await` is a prefix unary operator with the same precedence as in
  JavaScript (see "Async functions and `await`").

### `do` expressions

```swift
let grade = do {
	if score >= 80 { return "A" }
	return "B"
}
let n = do { try parse(input) } catch { -1 }
```

- `do { ... }` in expression position is a value-producing block: a lone
  expression statement yields its value implicitly; otherwise every path
  must `return` the value. `return` yields from the `do`, not from the
  enclosing function.
- The body runs inline: `await` and `try` inherit the enclosing context.
  `break` / `continue` cannot cross the `do` boundary (loops declared
  inside the body work normally).
- With `catch`, the do expression handles errors like the do-catch
  statement (see "Error handling"): the body may throw or `try`, and on
  an error the catch body — with the implicit `error: Error` binding —
  produces the value instead.
- The expected type propagates into both bodies
  (`let align: "left" | "right" = do { "left" }`).
- In statement position, `do` is always the do-catch *statement*; the
  expression form appears only where an expression is expected.

### Type tests (`is`)

```swift
if value is String { print(value) }
```

- `v is T` tests at runtime whether a union-typed `v` currently holds a
  member of type `T`, and evaluates to `Bool`. The runtime-discriminability
  rule (see "Literal types and unions") guarantees the test is decidable.
- `T` must be a non-literal member of `v`'s union; literal members are
  tested with `==` instead.
- Class members of a union are tested with JS `instanceof` under the hood.
  Protocol types cannot be the target of `is` (see "Protocols").
- `is` binds tighter than the arithmetic operators and looser than prefix
  unary (see the precedence list above).
- There is deliberately no `as` / `as?` cast syntax: narrowing from a union
  to a member happens only through control flow (see "Flow-sensitive
  narrowing").

### Closures

```swift
{ (x: Number) -> Number in return x * 2 }   // full form
{ x in x * 2 }                              // inferred params
{ $0 * 2 }                                  // shorthand arguments
xs.map { $0.x }                             // trailing closure
animate(duration: 1) { finish() }           // after call parens
```

- Parameter types are inferred from the expected function type
  (bidirectional checking); annotate when there is no context.
- A single-expression body is treated as an implicit `return` when a return
  value is expected.
- Trailing closures are not allowed in `if`/`while`/`for`/`switch` headers
  (wrap in parentheses instead), matching Swift.
- `await` cannot appear inside a closure body (async closures are not yet
  supported).

### String interpolation

`"count: $(n + 1)"` — any expression, converted with the same rules as
`print`. Compiles to a JS template literal.

## 5. Statements

```swift
if cond { ... } else if other { ... } else { ... }
if let x = optionalValue { ... }
if let x = optionalValue, !x.isEmpty { ... }
guard cond else { return }
guard let x = optionalValue else { return }
guard let x = optionalValue, !x.isEmpty else { return }
for i in 0..<10 { ... }        // exclusive range
for i in 0...10 { ... }        // inclusive range
for item in array { ... }
for (key, value) in dict { ... }
while cond { ... }
switch shape {
case .circle(let r): print(r)
case .rect(let w, let h): print(w * h)
default: print(0)
}
return expr
break / continue
x = v, x += v, x -= v, x *= v, x /= v
```

- Top-level statements execute in order (like Swift's `main.swift`); no
  `main` function is needed.
- `if` and `guard` take a comma-separated condition list: every condition
  must hold for the body to run. Each condition sees the bindings the
  earlier ones introduced, so `if let x = opt, !x.isEmpty { ... }` works.
  Type narrowing from a condition applies to the `else` branch only when
  the list holds exactly one condition.
- `guard cond else { ... }` / `guard let x = opt else { ... }`: the `else`
  body must exit the current scope with `return`, `break`, or `continue`;
  anything else is a compile error. Bindings introduced by `guard let` are
  visible in the statements after the `guard`.
- `for (key, value) in dict` iterates dictionary entries in insertion order.
- `switch` subjects may be enums (case patterns with positional `let`
  bindings), `Number`/`String`/`Bool` (literal patterns), or union-typed
  values (`case is T` patterns plus literal patterns; see "Flow-sensitive
  narrowing"). Cases do not fall through; `break` is not required. Enum
  switches must be exhaustive or have a `default`; a union switch that
  covers every member needs no `default`.
- Loop variables are immutable (`let`).

## 6. Type system

- **Bidirectional type checking**: expressions are checked against an
  expected type where one exists (closure parameters, `nil`, empty array
  and dictionary literals, literal-type narrowing, default values), and
  inferred bottom-up elsewhere.
- **Local inference**: `let`/`var` types come from their initializers.
  Function signatures are always explicit.
- **Generics**: generic functions are type-checked via unification at each
  call site; user-defined generic structs/enums/classes are instantiated
  the same way from their initializer or constructor arguments (see
  "Declarations"). Builtin generic types are `Array`, `Dictionary` (alias
  `Record`), and `Optional`. Generic host types (`declare type Box<T>`) are
  not supported.
- **Nominal typing** for structs, enums, classes, protocols, and host
  types.
- Condition expressions (`if`, `while`, ternary) must be `Bool`; there is no
  truthiness.
- Calls to `async` functions must be `await`ed (see "Async functions and
  `await`").
- Inside generic functions, values of type-parameter type are not copied on
  assignment (current limitation of value semantics).

### Flow-sensitive narrowing

```swift
fn describe(v: Number | String) -> String {
	if v is Number {
		return "number: $(v + 1)"        // v: Number
	}
	return v.uppercased()                // v: String — the remaining member
}
```

Union-typed and optional values are narrowed by control flow; since there
is no cast expression, these are the only narrowing tools:

- `if v is T { ... } else { ... }` — `v` is `T` in the then-branch and the
  remaining union in the else-branch.
- `!` inverts a test (`if !(v is T)` narrows the else way); `&&` composes
  tests within one condition.
- `guard v is T else { return }` — `v` is `T` for the statements after the
  `guard` (the `else` body must exit the scope, as with every `guard`).
- `x == nil` / `x != nil` narrow a plain optional `x` the same way.
  Nested optionals (`T??`) and optionals of a type parameter are not
  narrowed — their runtime value keeps its box, so the test only proves
  the outermost level; unwrap with `if let`.
- `switch v { case is T: ... }` narrows `v` in each case. A union switch
  that covers every member — literal members with literal patterns, other
  members with `case is T` — is exhaustive without a `default`.

## 7. Global namespace and scoping

Name resolution, innermost first (inner scopes may shadow outer ones):

```
[local scopes] → [script top-level] → [injected packages] → [builtins (stdlib + type names)]
```

- Injected package names are read-only globals; `expose: "global"`
  declarations are read-only too.
- `use` introduces its namespace binding or named bindings (and, for the
  namespace form, the names of the module's exported
  struct/enum/class/protocol types) into the script's top-level scope as
  read-only bindings (see "Modules").
- Duplicate declarations in the same scope are a compile error. Package-name
  and exposed-name collisions throw at `registerPackage` time on the host
  side.
- Values and types share a single namespace (`struct Point` and
  `class Circle` occupy both the type name and the initializer/constructor
  function).
- Closures capture variables by reference (like Swift classes' capture
  semantics; `var` captures observe later mutations).

## 8. Modules

```swift
// brushes (module source, provided by the host's module resolver)
export struct BrushSpec { var size: Number }
export fn makeSoftBrush(size: Number) -> BrushSpec {
	return BrushSpec(size: size)
}
fn helper() -> Number { return 1 }       // not exported: private to the module
```

```swift
// entry script
use brushes from "brushes"               // namespace binding
use { makeSoftBrush } from "brushes"     // named binding

let brush = brushes.makeSoftBrush(size: 12)
let direct = makeSoftBrush(size: 8)      // named uses bind unqualified
let spec: BrushSpec = brush              // exported types are visible unqualified
```

- `use <name> from "<specifier>"` binds the module's exports as a
  namespace under `<name>` (any identifier; it need not match the
  specifier). `use { a, b } from "<specifier>"` binds the listed exports —
  values and types alike — directly into the current scope.
- The specifier is a plain string literal (no interpolation) and is passed
  verbatim to the host's module resolver; it may contain any characters
  (`use geo from "pkgs/geo"`).
- `use` is only allowed at the top level.
- `export` may prefix `fn`, `let`, `var`, `struct`, `enum`, `class`, and
  `protocol` declarations. Non-exported declarations are private to the
  module.
- With a namespace binding, exported **values** are reached through the
  namespace (`brushes.makeSoftBrush(size: 12)`), while exported
  struct/enum/class/protocol **types** are additionally visible
  unqualified, because type annotations have no dotted form. A collision
  with another imported type or a local declaration is a compile error.
- An exported class or struct also carries its constructor value across
  the module boundary: after `use shapes from "shapes"`, the importer can
  construct `Circle(...)` and discriminate with `is Circle`.
- Module resolution is delegated to the host:
  `host.setModuleResolver((specifier) => source | null | Promise<source | null>)`.
  Returning `null` produces the compile diagnostic
  `Cannot resolve module 'x'`. The optional second argument
  `{ knownSpecifiers: string[] }` advertises resolvable specifiers to the
  editor: completion after `use ` inserts `<binding> from "<specifier>"`
  (the binding defaults to the specifier's last path segment), and
  completion inside the `from "..."` string offers the specifiers.
- Cyclic imports are a compile error.
- `export` in the entry script is allowed but has no effect.
- In the generated JS, modules are bundled as async IIFEs in dependency
  order (see "Compilation to JavaScript").

## 9. Async functions and `await`

```swift
async fn loadBrush(name: String) -> Brush {
	let data = await assets.fetch(path: name)
	return brushes.decode(data)
}

let brush = await loadBrush(name: "soft")    // top-level await is allowed
```

- `async fn` declares an asynchronous function. `declare async fn` declares
  an asynchronous host function (its runtime binding may return a
  `Promise`).
- `await expr` is a prefix unary operator with JavaScript-like precedence
  (see "Expressions").
- Calling an async function **requires** `await` — a Swift-style discipline
  enforced by the checker.
- Top-level `await` is allowed: the whole program executes as an async
  function, and `host.run()` returns a `Promise` that settles when the
  script finishes.
- `await` is not allowed inside closures (async closures are not yet
  supported).
- Implementation note: the surface `await` keyword is a type-checking
  marker; the compiler inserts the actual awaits at the asynchronous
  boundaries (calls) automatically. Whether a given function is emitted
  as an `async` JS function — and whether its calls are awaited — is
  decided by an effect analysis (see "Compilation to JavaScript"); the
  analysis never changes observable behavior.

## 10. Host injection (declarations + runtime bindings)

Hosts register packages consisting of Syrup declaration source plus runtime
values:

```typescript
import { createScriptHost } from "@paplico/syrup";

const host = createScriptHost();
host.registerPackage({
	name: "paplico",
	declarations: `
		declare type Layer {
			let name: String
			var opacity: Number
			fn addChild(child: Layer) -> Void
		}
		declare fn addLayer(name: String) -> Layer
		declare async fn flush() -> Void
	`,
	runtime: { addLayer: (name) => ..., flush: async () => ... },
});

host.setModuleResolver((specifier) => moduleSources.get(specifier) ?? null);

const { code, diagnostics } = await host.compile(source);
await host.run(code);
```

Declaration syntax (only valid in declaration sources, not in scripts):

```swift
declare fn name<T>(label param: Type, ...) -> Type
declare async fn name(label param: Type, ...) -> Type
declare let name: Type
declare type Name {
	let readOnlyProp: Type
	var mutableProp: Type
	fn method(arg: Type, optionalArg?: Type) -> Type
	mutating fn methodThatMutates(arg: Type) -> Type
}
```

- `declare type` introduces an opaque host type. Scripts cannot construct it;
  values come from host functions. `var` members are assignable, `let`
  members are read-only.
- `declare type Name<T> { ... }` declares a generic host type; member
  signatures may use the type parameters, and instances are produced by
  generic host functions (`declare fn expect<T>(value: T) -> Expectation<T>`
  in the stdlib is declared this way). Type arguments are erased at runtime.
- `declare async fn` declares an asynchronous host function; scripts must
  `await` its calls (see "Async functions and `await`").
- `mutating fn` marks a member that mutates its receiver: calling it through
  a `let` binding is a compile error.
- `expose: "namespace"` (default) makes the package visible as a single
  global (`paplico.addLayer(...)`). `expose: "global"` splices every
  declaration into the global scope (`addLayer(...)`).
- `param?: Type` marks a parameter callers may omit. Default parameter values
  are not allowed in declarations, because the runtime binding — not an
  emitted default expression — decides what an omitted argument becomes: the
  binding is called with `undefined` in that position, or with the argument
  dropped entirely when it is trailing. Outside declarations, `?` on a
  parameter is an error; write a default value instead.
- Argument labels are erased at compile time: a `declare fn`'s runtime
  binding is called positionally, in declaration order (defaults filled in).
- Host functions whose declared return type is optional may return a value,
  `null`, or `undefined`; `undefined` is normalized to `nil`.
- `compile`, `analyze`, `run`, `runSource`, and `loadModule` are async.
  `setModuleResolver` registers module resolution (see "Modules");
  `loadModule` compiles and runs a source as a module and exposes its
  exports to the host (see "Execution and sandboxing");
  `createWorkerRunner` runs compiled code in a Web Worker (see "Execution
  and sandboxing").

## 11. Execution and sandboxing

Compiled code can be executed in two ways:

- **In-process**: `await host.run(code)` runs the program in the host's JS
  realm. Use this for trusted scripts only.
- **Worker sandbox**: `host.createWorkerRunner(worker)` returns a runner
  (`run(code): Promise<void>`, `dispose()`) that executes the program inside
  a Web Worker. The worker's entry script must call `installWorkerRuntime()`
  from `@paplico/syrup/worker`.

Mechanics:

- Generated code never touches host values directly: every host interaction
  goes through the injected `__host` operations (`call` / `get` / `prop` /
  `setProp` / `method`). In-process these are direct calls; in Worker mode
  they become `postMessage` RPC.
- Host objects cross the Worker boundary as opaque handles: scripts can pass
  them back to host functions but cannot observe them as raw values.
- Function-typed arguments to host functions are not supported in Worker
  mode (runtime error).
- Struct instances passed to host functions in Worker mode are flattened
  to plain objects at the boundary (deeply, including structs inside
  arrays/dictionaries) — the host sees the same plain data it always did.
- Class instances cannot be passed to host functions in Worker mode
  (runtime error: "Class instances cannot cross the worker boundary") —
  structured cloning would strip their prototype and methods.

### Host-side module loading (`loadModule`)

`host.loadModule(source, options?)` compiles a source as a module, runs it,
and hands its exports back to the host:

```typescript
const module = await host.loadModule(source, { name: "tools" }); // name defaults to "main"
module.exports;                      // Record<string, unknown>
module.get("baseSize");              // 12
await module.call("double", [21]);   // 42 — labels are erased; positional args in declaration order
```

- The source is compiled as a module: only `export`ed declarations appear
  in `exports`, and its internal `use`s are resolved through the
  registered module resolver (see "Modules").
- Top-level statements run at load time and may call the host.
- `call(name, args)` always awaits the result, so it is safe regardless of
  whether the export was emitted synchronously. Exported functions can
  also be invoked directly (`module.exports.double(21)`) — this returns a
  bare value when the function was emitted synchronously and a `Promise`
  otherwise (see "Effect analysis (synchronous emission)").
- Values cross the boundary with the standard mapping: `nil` ⇔ `null`,
  dictionaries are `Map`s, enums are plain tagged objects, and structs are
  class instances whose fields are plain enumerable properties
  (`JSON.stringify` and property access see the same shape as before).
- Compile errors are thrown.
- Execution is in-process only; a Worker-sandboxed variant is not yet
  implemented.

## 12. Standard library

Free functions (global, implemented via the same injection mechanism):

- `print(value: T)` — host-overridable output.
- Math: `abs(x:) min(a:b:) max(a:b:) floor(x:) ceil(x:) round(x:) sqrt(x:)
  pow(base:exp:) sin(x:) cos(x:) atan2(y:x:) random()` and the constant
  `pi`. As everywhere, labels are optional at call sites: `abs(-3)` and
  `abs(x: -3)` are the same call.
- `expect(value: T) -> Expectation<T>` — assertion entry point (see below).

The stdlib also declares `Error`, an empty marker protocol (Swift's
`Error`); classes conform to it to model error values (see "Protocols").

`Expectation<T>` is a generic host type with the matcher methods:

- `toEqual(expected: T)` / `notToEqual(expected: T)` — structural deep
  equality over Syrup data: primitives, `nil`, arrays, dictionaries, and
  struct/enum values compare by content; reference class instances and host
  objects compare by identity.
- `toBeNil()` / `notToBeNil()`
- `toBeTrue()` / `toBeFalse()`
- `toBeGreaterThan(bound: Number)` / `toBeLessThan(bound: Number)`

A failed matcher throws a runtime error (`expected 3, got 2`); inside a
`@test` function the harness catches it and marks the test failed, anywhere
else it aborts the script like any runtime error. `toEqual`'s parameter is
typed `T`, so comparing against a differently-typed value is a compile
error.

Builtin type members:

- `Array<T>`: `count`, `isEmpty`, `first: T?`, `last: T?`,
  `append(element:)`, `insert(element:at:)`, `remove(at:) -> T`,
  `contains(element:)`, `map(transform: (T) -> U) -> Array<U>`,
  `filter(isIncluded: (T) -> Bool) -> Array<T>`,
  `reduce(initial: U, combine: (U, T) -> U) -> U`,
  `sorted(by: (T, T) -> Bool) -> Array<T>`, subscript `[Number] -> T`
  (out-of-range throws at runtime).
- `Dictionary<K, V>`: `count`, `isEmpty`, `keys: Array<K>`,
  `values: Array<V>`, `removeValue(forKey:) -> V?` (mutating), subscript
  read `[K] -> V?` and write `[K] = V` (see "Dictionaries"). On
  exhaustive-key dictionaries the subscript read returns a plain `V` and
  `removeValue(forKey:)` is unavailable.
- `String`: `count`, `isEmpty`, `uppercased()`, `lowercased()`,
  `contains(needle:)`, `hasPrefix(prefix:)`, `hasSuffix(suffix:)`,
  `split(separator:) -> Array<String>`.

`Array.contains` uses JS equality (`includes`); for struct elements this is
reference equality (current limitation).

The member type definitions of `Array`, `String`, and `Dictionary` are
themselves written in Syrup's declaration syntax (`declare type
Array<T> { ... }`, with `mutating fn` where appropriate) and parsed when the
compiler starts up (`src/checker/coreDeclarations.ts`). The matching
JavaScript implementations live on the emitter side.

## 13. Testing (`@test` + `runTests`)

```swift
@test
fn clampsIntoUnitRange() {
	expect(clamp01(1.5)).toEqual(1)
	expect(clamp01(-2)).toEqual(0)
}
```

Compilation has two modes:

- **run mode** (default, `compile(source)`): `@test` functions are dropped
  from the output entirely.
- **test mode** (`compile(source, { mode: "test" })`): the whole program is
  emitted, followed by a harness that runs every `@test` function in
  declaration order. Top-level statements run first (setup), then each test;
  a test fails when it throws (a failed `expect` matcher or any runtime
  error), and one test's failure does not stop the others. Each outcome is
  reported through `__host.call("__syrupTest", "report", [name, passed,
  error])`.

Host APIs:

- `ScriptHost.runTests(source)` compiles in test mode, runs in-process, and
  resolves to `{ name, passed, error }[]` (throws on compile errors).
- `WorkerRunner.runTests(code)` runs test-mode compiled code in the Worker
  sandbox and collects the same results.

## 14. Compilation to JavaScript

`compile(source)` produces ES2020+ JavaScript for an async program body;
`run(code)` wraps it in an async function that receives the injected
host-operation object (`__host`) and returns a `Promise` (the program may
contain top-level `await`). All host interaction goes through `__host` (see
"Execution and sandboxing").

| Syrup | JavaScript |
| --- | --- |
| `nil` | `null` |
| `a ?? b` | `a ?? b` |
| `a?.b` | `a?.b` |
| `a!` | `__force(a)` (throws on `null`) |
| `"a$(x)"` | `` `a${x}` `` |
| `struct Point { ... }` / `Point(x: 1, y: 2)` | JS `class` with a positional memberwise `constructor` (and a symbol-keyed `static [__syrupStruct]` marker; the symbol is injected as an AsyncFunction parameter) / `new Point(1, 2)` |
| `Shape.circle(radius: r)` | `{ $case: "circle", radius: r }` |
| struct method call | instance method call (`p.scaled(2)`) |
| enum method call | free-function call (static dispatch) |
| `class Dog: Animal { ... }` | JS `class extends` with a native `constructor` (`super.init(...)` → `super(...)`) when the whole init tree is sync; trees containing an awaiting `init` use `static __create` + `__init` instead |
| `switch` | `if`/`else` chain (enum subjects branch on `.$case`) |
| closure / `$0` | arrow function |
| `for i in a..<b` | `for (let i = a; i < b; i++)` |
| labeled call `f(to: x)` | positional call `f(x)` |
| `[a: 1]` / `[:]` / dictionary subscript | `Map` construction / access |
| `async fn` / `await f(x)` | `async` emission and awaits are decided by the effect analysis (see below); effect-free functions become plain synchronous functions |
| `use m from "m"` | dependency-ordered async IIFE: `const __mod_m = await (async () => { ...; return { exports }; })()` (non-identifier specifiers get a sanitized, hashed binding name) |
| `@test fn t() { ... }` | run mode: dropped; test mode: emitted plus a trailing harness reporting through `__host.call("__syrupTest", "report", ...)` |
| `throw e` | `throw __throwVal(e)` (wraps the value in a symbol-tagged JS `Error`) |
| `do { ... } catch { ... }` | JS `try`/`catch` whose catch re-throws untagged errors (traps, host exceptions) and otherwise binds `error` to the tagged value |
| `try f()` | erased (`try` is a compile-time marker) |
| `do { ... }` expression | immediately-invoked arrow function `(() => { ... })()`, made `async` and awaited when its body awaits |
| host call / member access | `__host` operations (`call` / `get` / `prop` / `setProp` / `method`) |
| value-semantics copy | `__copy(value, shape)` (shape derived from the static type; copy functions for generic types are generated per instantiation) |

`switch` is emitted as an `if`/`else` chain rather than a JS `switch`; this
keeps a Syrup loop's `break` inside a `switch` from being captured by the
generated `switch` statement.

Tag-only structs (no fields, no methods) that are never used as values —
not constructed, not exported, not targeted by `is` / `case is`, and not a
member of a union — are dropped from the output entirely. Phantom type tags
(`struct Meters {}` used only as a type argument) therefore cost nothing at
runtime.

### Effect analysis (synchronous emission)

The compiler runs a bundle-wide effect analysis to decide, per function,
whether it must be emitted as an `async` JS function. A user function,
closure, method, or `init` that can never reach a host operation (a
`__host` call, property access, or `declare let` read), a surface
`async fn`, or an unknown-function-value call is emitted as a **plain
synchronous JS function**, and the `await`s on its calls are removed.

- **Soundness rule**: a call is only de-awaited when every possible callee
  is proven to be sync-emitted; everything else stays awaited
  (conservative).
- **Function values are tracked** through immutable `let` bindings
  (`let f = { ... }`, `let g = someFn`) and through the parameters of
  `fn`s, struct/enum methods, and class `init`s ("parameter slots"): a
  parameter's color is the join of every function value passed for it at
  any call site in the bundle, so `fn apply(f: (Number) -> Number)`
  compiles synchronously when every caller passes a sync closure. A
  function whose reference escapes to an untracked place (stored in data
  structures, passed where the analysis loses sight of it, or exported —
  the host can call exports with arbitrary callbacks) has its parameter
  slots pinned async. Calls through `var` bindings, closure parameters,
  and class method parameters stay awaited.
- `Array.map` / `filter` / `reduce` / `sorted(by:)` invoked with a pure
  closure use synchronous helper variants (`__arrMapS` etc.) instead of
  the awaiting ones.
- **Class methods use method slots**: a method definition is colored by its
  own body (awaiting a sync function is safe, so overrides need not share a
  color), while a dynamic call `obj.m()` is awaited when *any* override of
  `m` reachable from the static type of `obj` — including overrides in
  other modules of the bundle — is async. Protocol-typed calls join over
  every conforming class's implementation. `super.m()`, `super.init()`,
  and `Circle(...)` construction resolve statically, so they use the exact
  target's color; a subclass `init` chains its parent's `init` color.
- Sync coloring propagates across module boundaries: the analysis runs once
  over the whole dependency-ordered bundle, so importers de-await calls to
  sync exported functions and methods.
- Surface semantics are unchanged: this optimization never changes
  observable behavior.

The runtime is a handful of embedded helpers (`__force`, `__copy`, bounds-
checked subscripts, `sorted`); the generated code has no external imports.
Source maps are not yet implemented (compile-time diagnostics carry source
spans already).

## 15. Not yet implemented

`Array` value semantics (copy-on-write), struct `==`, range values outside
`for`-`in` headers, async closures (`await` inside closures), bare `.case`
expressions, function-typed arguments and class instances across the Worker
boundary, Worker-sandboxed `loadModule` execution, source maps, struct
conformance to protocols (witness tables), protocol inheritance, computed
properties, typed `throws(E)`, throwing closures and function-typed values,
`declare fn ... throws` host functions, `try?` / `try!`, `.some` / `.none`
switch patterns over optionals, `Optional.map` / `flatMap`, `[T?]` /
`[K: T?]` crossing generic boundaries at non-optional instantiations, and
protocol conformance of generic classes whose members use `T?`.
