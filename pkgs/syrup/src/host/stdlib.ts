import { __syrupStruct } from "../emit/runtime";

/**
 * The standard library is implemented through the same declaration +
 * runtime-binding mechanism as host packages (registered as the exposed
 * "std" package).
 */
export const STDLIB_DECLARATIONS = `
// Marker protocol for error values (Swift's Error): no requirements.
protocol Error {}
declare fn print<T>(value: T) -> Void
declare fn abs(x: Number) -> Number
declare fn min(a: Number, b: Number) -> Number
declare fn max(a: Number, b: Number) -> Number
declare fn floor(x: Number) -> Number
declare fn ceil(x: Number) -> Number
declare fn round(x: Number) -> Number
declare fn sqrt(x: Number) -> Number
declare fn pow(base: Number, exp: Number) -> Number
declare fn sin(x: Number) -> Number
declare fn cos(x: Number) -> Number
declare fn atan2(y: Number, x: Number) -> Number
declare fn random() -> Number
declare let pi: Number
declare type Expectation<T> {
	fn toEqual(expected: T) -> Void
	fn notToEqual(expected: T) -> Void
	fn toBeNil() -> Void
	fn notToBeNil() -> Void
	fn toBeTrue() -> Void
	fn toBeFalse() -> Void
	fn toBeGreaterThan(bound: Number) -> Void
	fn toBeLessThan(bound: Number) -> Void
}
declare fn expect<T>(value: T) -> Expectation<T>
`;

export function createStdlibRuntime(
	stdout: (text: string) => void,
): Record<string, unknown> {
	return {
		print: (value: unknown) => stdout(formatValue(value)),
		abs: Math.abs,
		min: Math.min,
		max: Math.max,
		floor: Math.floor,
		ceil: Math.ceil,
		round: Math.round,
		sqrt: Math.sqrt,
		pow: Math.pow,
		sin: Math.sin,
		cos: Math.cos,
		atan2: Math.atan2,
		random: Math.random,
		pi: Math.PI,
		expect: (value: unknown) => new SyrupExpectation(value),
	};
}

/** Runtime side of the `Expectation<T>` host type. Failures throw. */
class SyrupExpectation {
	public constructor(private value: unknown) {}

	public toEqual(expected: unknown): void {
		if (!deepEqual(this.value, expected)) {
			this.fail(`expected ${formatValue(expected)}`);
		}
	}

	public notToEqual(expected: unknown): void {
		if (deepEqual(this.value, expected)) {
			this.fail(`expected anything but ${formatValue(expected)}`);
		}
	}

	public toBeNil(): void {
		if (this.value !== null && this.value !== undefined) {
			this.fail("expected nil");
		}
	}

	public notToBeNil(): void {
		if (this.value === null || this.value === undefined) {
			this.fail("expected a value, got nil");
		}
	}

	public toBeTrue(): void {
		if (this.value !== true) this.fail("expected true");
	}

	public toBeFalse(): void {
		if (this.value !== false) this.fail("expected false");
	}

	public toBeGreaterThan(bound: number): void {
		if (typeof this.value !== "number" || !(this.value > bound)) {
			this.fail(`expected a number greater than ${bound}`);
		}
	}

	public toBeLessThan(bound: number): void {
		if (typeof this.value !== "number" || !(this.value < bound)) {
			this.fail(`expected a number less than ${bound}`);
		}
	}

	private fail(expectation: string): never {
		throw new Error(`${expectation}, got ${formatValue(this.value)}`);
	}
}

/**
 * Structural equality over Syrup data: primitives, nil (null/undefined),
 * arrays, dictionaries (Map), and struct/enum data objects. Reference class
 * instances and host objects only compare equal by identity.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || a === undefined || b === null || b === undefined) {
		return (a === null || a === undefined) === (b === null || b === undefined);
	}
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	if (a instanceof Map || b instanceof Map) {
		if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
			return false;
		}
		for (const [key, value] of a) {
			if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
		}
		return true;
	}
	if (!isDataObject(a) || !isDataObject(b)) return false;
	const aRecord = a as Record<string, unknown>;
	const bRecord = b as Record<string, unknown>;
	const aKeys = Object.keys(aRecord);
	if (aKeys.length !== Object.keys(bRecord).length) return false;
	return aKeys.every(
		(key) => key in bRecord && deepEqual(aRecord[key], bRecord[key]),
	);
}

/** Plain data objects and struct instances (value data) compare structurally. */
function isDataObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value) as {
		constructor?: { [__syrupStruct]?: boolean };
	} | null;
	return (
		proto === Object.prototype ||
		proto === null ||
		proto.constructor?.[__syrupStruct] === true
	);
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "nil";
	if (isOptionalBox(value)) {
		return `Optional(${formatValue(value.$some)})`;
	}
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/**
 * The boxed some-case of a nested optional (`{$some: value}`). Like the
 * `$case` tag on enum values, the `$some` key is a representation convention:
 * Syrup identifiers cannot produce it, so plain one-key objects are safe to
 * treat as boxes.
 */
function isOptionalBox(value: unknown): value is { $some: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$some";
}
