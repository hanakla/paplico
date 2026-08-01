# @paplico/syrup

Syrup is a statically typed, Swift-flavored scripting language for Paplico
automation. Scripts compile to plain JavaScript and run against host APIs
that are injected from outside — the language core knows nothing about
Paplico itself.

```swift
let layer = paplico.addLayer(name: "bg")

for i in 0..<20 {
	layer.addRect(x: i * 40, y: 0, w: 2, h: 600)
}

let doubled = [1, 2, 3].map { $0 * 2 }
print("count: $(doubled.count)")
```

- **Swift-like syntax**: labeled arguments, trailing closures, `$0`
  shorthand, string interpolation, `struct` / `enum` with associated values,
  optionals (`T?`, `if let`, `guard let`, `??`, `?.`, `!`) with full
  nested-optional semantics (`[Number?].first` is `Number??` and
  `.some(nil)` ≠ `.none`, like Swift), dictionaries (`[String: Number]`,
  literals `[a: 1]` / `[:]`), `switch` pattern matching.
- **Static types**: bidirectional type checking with local inference,
  generic functions, generic structs/enums (`struct Pair<A, B>`), generic
  constraints (`fn render<T: Drawable>`), and literal / union types
  (`"left" | "right"`, `Number | String`) with `is`-based flow narrowing,
  checked entirely at compile time.
- **Value semantics**: structs and enums copy on assignment, like Swift,
  and can declare methods (`mutating fn` for struct mutation).
- **Classes and protocols**: reference-semantics classes with single
  inheritance (`override fn`, `super`), generics (`class Stack<T>`), and
  `instanceof`-discriminated class unions (`Circle | Rect` narrowed with
  `is`); protocols are nominal, implemented by classes, with dynamic
  dispatch — the stdlib ships the `Error` marker protocol.
- **Error handling**: `throws` functions, `throw`, `try` call marking, and
  `do`-`catch` with the implicit `error: Error` binding; runtime traps
  (force-unwrap, out-of-range subscripts) stay uncatchable, like Swift's.
- **`do` expressions**: value-producing blocks with implicit single-
  statement yield — `let a = do { try parse(x) } catch { 0 }`.
- **Modules**: top-level `use ... from "..."` (namespace or named bindings)
  with `export`-controlled visibility;
  module sources are resolved by the host and bundled at compile time.
- **`async` / `await`**: `async fn`, asynchronous host functions
  (`declare async fn`), and top-level `await`.
- **Testing**: `@test` functions with `expect(...)` matcher chains
  (`toEqual`, `toBeNil`, ...); `host.runTests(source)` runs them and
  reports results, while normal runs strip them from the output.
- **Host injection**: type declarations and runtime bindings are registered
  per package; nothing is hardcoded.
- **Sandboxed execution**: run in-process, or inside a Web Worker where all
  host access becomes message-passing RPC.
- **Monaco support**: syntax highlighting, live diagnostics, completion,
  hover, signature help, and go-to-definition (within a document).

See [specification.md](./specification.md) for the full language reference.

## Differences from Swift

Syrup is Swift-flavored, not Swift-compatible. The deliberate departures:

| Swift | Syrup |
| --- | --- |
| `func` | `fn` |
| `"\(x)"` interpolation | `"$(x)"` (escape a literal `$(` as `\$(`) |
| `import Module` | `use mod from "specifier"` / `use { member } from "..."`, resolved by the host |
| `protocol` conformance by structs, enums, and classes | `protocol` implemented by classes only (no struct/enum conformance) |
| `Int` / `Double` / `Float` | a single `Number` type |
| Argument labels are required as declared | labels are optional at call sites and may mix with positional arguments (arguments evaluate in parameter order) |
| No union types (use enums) | anonymous unions (`Number \| String`) and literal types (`"left" \| "right"`) with `is`-based flow narrowing |
| `as?` / `as!` casts | no casts — narrowing happens only through `is` and control flow |
| `Optional` is an enum (`.some` / `.none` patterns, `map` / `flatMap`) | not an enum — no optional patterns or combinators; nested optionals still work via a boxed runtime representation (`{$some: v}`), printed Swift-style (`Optional(nil)`) |
| — | exhaustive-key dictionaries (`["left" \| "right": Number]`) with non-optional subscript reads, and computed keys (`[[expr]: 1]`) |
| `Array` / `Dictionary` are value types (copy-on-write) | reference semantics; only structs and enums copy on assignment |
| typed catches (`catch let e as MyError`), `try?` / `try!`, `rethrows`, `defer` | untyped `throws` with a single catch-all `catch` binding the implicit `error: Error`; runtime traps (force-unwrap of `nil`, out-of-range subscripts) and host exceptions are uncatchable |
| `if` / `switch` expressions (`do` expressions are only a pitch) | value-producing `do { ... }` / `do`-`catch` expressions (a lone expression statement yields implicitly, otherwise `return` yields the value); no `if` / `switch` expressions |
| Generic constraints with `where` clauses and composition (`T: A & B`) | a single inline upper bound (`<T: C>`, class or protocol) |
| Initialize own stored properties before `super.init` | call `super.init` first (JS `super()` semantics) |
| `public` / `internal` / `private` | no access control; `export` defines the module surface |
| swift-testing `@Test` + `#expect` macros | built-in `@test` attribute + `expect(...)` matcher chains, run via `host.runTests` |
| Extensions, `typealias`, tuples, computed properties, raw-value enums, `defer`, `inout`, operator overloading | not part of the language |

## Usage

### Compile and run

```typescript
import { createScriptHost } from "@paplico/syrup";

const host = createScriptHost({ stdout: (text) => console.log(text) });

host.registerPackage({
	name: "paplico",
	// Type definitions, written in Syrup's declaration syntax
	declarations: `
		declare type Layer {
			let name: String
			var opacity: Number
			fn addChild(child: Layer) -> Void
		}
		declare fn addLayer(name: String) -> Layer
	`,
	// Runtime bindings, keyed by declared name (labels are erased;
	// functions are called positionally in declaration order)
	runtime: {
		addLayer: (name) => ({ name, opacity: 1, addChild: () => {} }),
	},
	// "namespace" (default): scripts use `paplico.addLayer(...)`.
	// "global": every declaration becomes a bare global.
	expose: "namespace",
});

const { code, diagnostics } = await host.compile(source);
if (code !== null) {
	await host.run(code);
}
```

`compile`, `analyze`, `run`, and `runSource` are async; scripts may use
top-level `await`, and `run` resolves when the script finishes. Host
functions declared with an optional return type (`-> T?`) may return a
value, `null`, or `undefined` — `undefined` is normalized to `nil`.

The standard library (`print`, math functions, `Array` / `String` /
`Dictionary` members) is built on the same mechanism and registered
automatically.

### Modules

Scripts bind modules with `use ... from "<specifier>"`; the host decides
how a specifier maps to Syrup source (returning `null` reports "Cannot
resolve module"):

```typescript
host.setModuleResolver(
	async (specifier) => {
		return specifier === "brushes" ? brushesSource : null;
	},
	// Optional: advertise resolvable specifiers so the Monaco editor can
	// complete `use ` (inserts `brushes from "brushes"`) and `from "..."`.
	{ knownSpecifiers: ["brushes"] },
);
```

```swift
// brushes (module source): `export` marks the public surface
export fn makeSoftBrush(size: Number) -> Brush { ... }
```

```swift
// entry script: namespace binding, or named bindings
use brushes from "brushes"
use { makeSoftBrush } from "brushes"

let brush = brushes.makeSoftBrush(size: 12)
let other = makeSoftBrush(size: 8)
```

### Tests

`@test` functions assert with `expect(...)` chains and run through
`host.runTests` (in-process) or `WorkerRunner.runTests` (sandboxed):

```swift
fn clamp01(value: Number) -> Number {
	return min(max(value, 0), 1)
}

@test
fn clampsIntoUnitRange() {
	expect(clamp01(1.5)).toEqual(1)
	expect(clamp01(-2)).toEqual(0)
}
```

```typescript
const results = await host.runTests(source);
// [{ name: "clampsIntoUnitRange", passed: true, error: null }]
```

Top-level statements run first, then each test in declaration order; a
test fails when it throws (a failed matcher or any runtime error). Normal
`compile`/`run` drops `@test` functions from the output entirely.

### Loading modules from the host

`host.loadModule` compiles a source as a module, runs its top-level
statements, and returns the exports for host-side use:

```typescript
const module = await host.loadModule(source, { name: "tools" }); // name defaults to "main"

module.exports;                      // Record<string, unknown>
module.get("baseSize");              // 12
await module.call("double", [21]);   // 42 — labels are erased; positional args in declaration order
```

Only `export`ed declarations appear in `exports`; the module's internal
`use`s are resolved through the registered module resolver. Top-level
statements run at load time and may call the host. `call` always awaits,
so it is safe no matter how the export was compiled; calling
`module.exports.double(21)` directly also works — note that it returns a
bare value when the function was compiled synchronously and a `Promise`
otherwise. Values map as usual: `nil` ⇔ `null`, dictionaries are `Map`s,
and structs/enums are plain objects (enums carry a `$case` tag). Compile
errors are thrown. Execution is in-process only (no Worker sandbox yet).

### Worker sandbox

`host.run(code)` executes in-process and is meant for trusted scripts. For
isolation, run the same compiled code inside a Web Worker:

```typescript
// worker entry
import { installWorkerRuntime } from "@paplico/syrup/worker";
installWorkerRuntime();

// main thread
const runner = host.createWorkerRunner(worker);
await runner.run(code);
runner.dispose();
```

Host objects cross the boundary as opaque handles, and every host call
becomes a `postMessage` RPC. Function-typed arguments to host functions are
not supported in Worker mode, and class instances cannot cross the worker
boundary (structured cloning would strip their prototype).

### Monaco editor

```typescript
import * as monaco from "monaco-editor";
import { registerSyrup } from "@paplico/syrup";

const dispose = registerSyrup(monaco, host);
```

`monaco-editor` is a type-only dependency; the Monaco instance is injected,
so this package adds no runtime dependency on it. `LanguageService` is also
exported directly for non-Monaco tooling (offsets in, plain data out;
`update(text)` is async).

## Development

```bash
# Run tests
yarn workspace @paplico/syrup test

# Type check
yarn workspace @paplico/syrup typecheck
```

Layering: `syntax/` (chevrotain lexer/parser → AST) → `checker/`
(bidirectional type checker) → `emit/` (JS emitter + embedded runtime).
`host/`, `runner/`, and `service/` compose those layers; `monaco/` depends
only on `service/`.

## Not yet implemented

`Array` value semantics (copy-on-write), struct equality, range values
outside `for`, async closures, bare `.case` expressions, function-typed
arguments and class instances across the Worker boundary, Worker-sandboxed
`loadModule` execution, source maps, struct conformance to protocols
(witness tables), protocol inheritance, computed properties, typed
`throws(E)`, throwing closures, `declare fn ... throws` host functions,
`try?` / `try!`, `.some` / `.none` switch patterns over optionals,
`Optional.map` / `flatMap`, `[T?]` crossing generic boundaries at
non-optional instantiations.
