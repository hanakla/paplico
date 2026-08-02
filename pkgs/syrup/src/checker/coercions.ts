// Runtime-representation coercions for nested optionals.
//
// Values of type `T?` inside generic code are always boxed
// (`null | {$some: v}`) so a single emitted body works for every `T`.
// Concrete code boxes only when the inner type is itself optional. Where a
// generic signature position `optional(typeParam)` is instantiated with a
// non-optional type, the two conventions differ by exactly one box and a
// lossless conversion is inserted at the boundary. Host (declare) boundaries
// instead use plain JS values: every none is `null`, so a boxed level is
// added/removed when crossing into or out of host code.

import type { FuncType, Type } from "./types";
import { boxedRepr } from "./types";
import { type Substitution, substitute } from "./unify";

export type Coercion =
	/** Unconditional `{$some: ...}` nesting (optional injection). */
	| { kind: "wrap"; count: number }
	/** Null-checked add-one-box: `v == null ? null : {$some: co(v)}`. */
	| { kind: "box"; inner: Coercion | null }
	/** Null-checked remove-one-box: `v == null ? null : co(v.$some)`. */
	| { kind: "unbox"; inner: Coercion | null }
	/** Descend one repr-equal optional layer and convert beneath it. */
	| { kind: "opt"; boxed: boolean; inner: Coercion }
	/** Eta-wrap a function value; params convert opposite to the return. */
	| { kind: "func"; params: (Coercion | null)[]; ret: Coercion | null }
	| { kind: "seq"; list: Coercion[] };

/** Coercions applied around an expression, relative to its value-copy. */
export interface CoercionMark {
	/** Applied before a value-semantics copy (into the concrete repr). */
	pre?: Coercion;
	/** Applied after a value-semantics copy (out of the concrete repr). */
	post?: Coercion;
}

export type CoercionResult = Coercion | null | "unsupported";

export function seqCoercion(a: Coercion, b: Coercion): Coercion {
	const list = [
		...(a.kind === "seq" ? a.list : [a]),
		...(b.kind === "seq" ? b.list : [b]),
	];
	return { kind: "seq", list };
}

/**
 * Conversion for a value whose declared (generic-side) type is `declared`,
 * instantiated by `subst`. "toGeneric" converts a concrete value into the
 * uniform convention; "fromGeneric" the reverse. Returns null when the
 * representations already agree, and "unsupported" when a conversion would
 * sit under a mutable reference structure (arrays / dictionaries alias, so
 * elements cannot be rewritten at the boundary).
 */
export function genericCoercion(
	declared: Type,
	subst: Substitution,
	dir: "toGeneric" | "fromGeneric",
): CoercionResult {
	switch (declared.kind) {
		case "optional": {
			const genericBoxed =
				declared.inner.kind === "optional" ||
				declared.inner.kind === "typeParam";
			const inst = substitute(declared, subst);
			if (inst.kind !== "optional") return null;
			const concreteBoxed = boxedRepr(inst);
			const inner = genericCoercion(declared.inner, subst, dir);
			if (inner === "unsupported") return "unsupported";
			if (genericBoxed === concreteBoxed) {
				return inner === null
					? null
					: { kind: "opt", boxed: genericBoxed, inner };
			}
			// Only genericBoxed && !concreteBoxed can occur: substitution never
			// makes a concrete inner type more optional than its declaration.
			return dir === "fromGeneric"
				? { kind: "unbox", inner }
				: { kind: "box", inner };
		}
		case "func":
			return funcCoercion(declared, (t, d) =>
				genericCoercion(t, subst, d === "co" ? dir : flipGeneric(dir)),
			);
		case "array": {
			const inner = genericCoercion(declared.element, subst, dir);
			return inner === null ? null : "unsupported";
		}
		case "dictionary": {
			const inner = genericCoercion(declared.value, subst, dir);
			return inner === null ? null : "unsupported";
		}
		default:
			// Type params are opaque values; nominal generic types store their
			// optional-of-param members uniformly, so instances pass through.
			return null;
	}
}

/**
 * Conversion between host-plain values (plain JS: every none is `null`) and
 * the concrete Syrup repr, for a declared host signature position. Host code
 * cannot express `.some(nil)`, so a host `null` always maps to the outer
 * none — a documented convention, not a checked property.
 */
export function hostCoercion(
	declared: Type,
	subst: Substitution,
	dir: "toHost" | "fromHost",
): CoercionResult {
	switch (declared.kind) {
		case "optional": {
			const inst = substitute(declared, subst);
			if (inst.kind !== "optional") return null;
			const inner = hostCoercion(declared.inner, subst, dir);
			if (inner === "unsupported") return "unsupported";
			if (boxedRepr(inst)) {
				return dir === "fromHost"
					? { kind: "box", inner }
					: { kind: "unbox", inner };
			}
			return inner === null ? null : { kind: "opt", boxed: false, inner };
		}
		case "func":
			return funcCoercion(declared, (t, d) =>
				hostCoercion(t, subst, d === "co" ? dir : flipHost(dir)),
			);
		case "array": {
			const inner = hostCoercion(declared.element, subst, dir);
			return inner === null ? null : "unsupported";
		}
		case "dictionary": {
			const inner = hostCoercion(declared.value, subst, dir);
			return inner === null ? null : "unsupported";
		}
		default:
			return null;
	}
}

function flipGeneric(
	dir: "toGeneric" | "fromGeneric",
): "toGeneric" | "fromGeneric" {
	return dir === "toGeneric" ? "fromGeneric" : "toGeneric";
}

function flipHost(dir: "toHost" | "fromHost"): "toHost" | "fromHost" {
	return dir === "toHost" ? "fromHost" : "toHost";
}

/** Shared func-type handling: params convert contravariantly ("contra"). */
function funcCoercion(
	declared: FuncType,
	convert: (type: Type, variance: "co" | "contra") => CoercionResult,
): CoercionResult {
	const params = declared.params.map((p) => convert(p.type, "contra"));
	const ret = convert(declared.ret, "co");
	if (params.some((p) => p === "unsupported") || ret === "unsupported") {
		return "unsupported";
	}
	const paramCos = params as (Coercion | null)[];
	if (paramCos.every((p) => p === null) && ret === null) return null;
	// An eta-wrapper cannot convert a promised result synchronously.
	if (declared.isAsync && ret !== null) return "unsupported";
	return { kind: "func", params: paramCos, ret };
}
