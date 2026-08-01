import type { FuncType, Type, TypeParamInfo } from "./types";
import { literalBase, typeEquals } from "./types";

/**
 * Assignability: exact match, literal-to-base widening, T into T?/unions,
 * and class subtyping (superclass chain / declared protocol conformance).
 * No other implicit conversions.
 */
export function typeConforms(actual: Type, expected: Type): boolean {
	if (typeEquals(actual, expected)) return true;
	if (actual.kind === "error" || expected.kind === "error") return true;
	if (actual.kind === "union") {
		return actual.members.every((m) => typeConforms(m, expected));
	}
	if (expected.kind === "union") {
		return expected.members.some((m) => typeConforms(actual, m));
	}
	if (expected.kind === "optional") {
		return typeConforms(actual, expected.inner);
	}
	if (actual.kind === "literal") {
		return typeEquals(literalBase(actual), expected);
	}
	// A constrained type param conforms to whatever its upper bound conforms to.
	if (actual.kind === "typeParam" && actual.info.constraint) {
		return typeConforms(actual.info.constraint, expected);
	}
	if (actual.kind === "class") {
		if (expected.kind === "class") {
			for (
				let cur: (Type & { kind: "class" }) | null = actual;
				cur !== null;
				cur = instantiatedSuperclass(cur)
			) {
				if (typeEquals(cur, expected)) return true;
			}
			return false;
		}
		if (expected.kind === "protocol") {
			for (
				let cur: (Type & { kind: "class" }) | null = actual;
				cur !== null;
				cur = instantiatedSuperclass(cur)
			) {
				const subst = buildSubst(cur.info.typeParams, cur.typeArgs);
				for (const conformed of cur.info.protocols) {
					if (typeEquals(substitute(conformed, subst), expected)) return true;
				}
			}
			return false;
		}
	}
	return false;
}

/** The superclass of a class instance, with type arguments applied. */
export function instantiatedSuperclass(
	type: Type & { kind: "class" },
): (Type & { kind: "class" }) | null {
	const parent = type.info.superclass;
	if (parent === null) return null;
	const applied = substitute(
		parent,
		buildSubst(type.info.typeParams, type.typeArgs),
	);
	return applied.kind === "class" ? applied : null;
}

/** Per-call-site solution for a generic function's type parameters. */
export type Substitution = Map<number, Type>;

export function buildSubst(
	typeParams: TypeParamInfo[],
	typeArgs: Type[],
): Substitution {
	const subst: Substitution = new Map();
	for (const [i, param] of typeParams.entries()) {
		const arg = typeArgs[i];
		if (arg !== undefined) subst.set(param.id, arg);
	}
	return subst;
}

/** Replace solved type params in `type`; unsolved ones are left in place. */
export function substitute(type: Type, subst: Substitution): Type {
	if (subst.size === 0) return type;
	switch (type.kind) {
		case "typeParam":
			return subst.get(type.info.id) ?? type;
		case "array": {
			const element = substitute(type.element, subst);
			return element === type.element ? type : { kind: "array", element };
		}
		case "dictionary": {
			const key = substitute(type.key, subst);
			const value = substitute(type.value, subst);
			return key === type.key && value === type.value
				? type
				: { kind: "dictionary", key, value };
		}
		case "optional": {
			const inner = substitute(type.inner, subst);
			return inner === type.inner ? type : { kind: "optional", inner };
		}
		case "func": {
			return {
				kind: "func",
				isAsync: type.isAsync,
				throws: type.throws,
				typeParams: type.typeParams,
				params: type.params.map((p) => ({
					...p,
					type: substitute(p.type, subst),
				})),
				ret: substitute(type.ret, subst),
			};
		}
		case "struct":
			return {
				kind: "struct",
				info: type.info,
				typeArgs: type.typeArgs.map((a) => substitute(a, subst)),
			};
		case "enum":
			return {
				kind: "enum",
				info: type.info,
				typeArgs: type.typeArgs.map((a) => substitute(a, subst)),
			};
		case "class":
			return {
				kind: "class",
				info: type.info,
				typeArgs: type.typeArgs.map((a) => substitute(a, subst)),
			};
		case "protocol":
			return {
				kind: "protocol",
				info: type.info,
				typeArgs: type.typeArgs.map((a) => substitute(a, subst)),
			};
		case "host":
			return {
				kind: "host",
				info: type.info,
				typeArgs: type.typeArgs.map((a) => substitute(a, subst)),
			};
		case "union":
			return {
				kind: "union",
				members: type.members.map((m) => substitute(m, subst)),
			};
		default:
			return type;
	}
}

/**
 * Unify `declared` (may contain type params of the callee) against the
 * concrete `actual` type, extending `subst`. Returns false on mismatch.
 */
export function unify(
	declared: Type,
	actual: Type,
	subst: Substitution,
	solvable: TypeParamInfo[],
): boolean {
	if (declared.kind === "error" || actual.kind === "error") return true;
	if (declared.kind === "typeParam") {
		if (!solvable.some((p) => p.id === declared.info.id)) {
			return typeEquals(declared, actual);
		}
		const existing = subst.get(declared.info.id);
		if (existing !== undefined) {
			return typeEquals(substitute(existing, subst), actual);
		}
		subst.set(declared.info.id, actual);
		return true;
	}
	// Generic solving does not look inside unions/literals; fall back to
	// plain conformance for them.
	if (
		declared.kind === "union" ||
		actual.kind === "union" ||
		declared.kind === "literal" ||
		actual.kind === "literal"
	) {
		return typeConforms(actual, substitute(declared, subst));
	}
	if (declared.kind !== actual.kind) {
		// A concrete value can flow into an optional slot: T unifies with U?.
		if (declared.kind === "optional") {
			return unify(declared.inner, actual, subst, solvable);
		}
		// A class value can flow into a protocol slot.
		if (declared.kind === "protocol" && actual.kind === "class") {
			return typeConforms(actual, substitute(declared, subst));
		}
		return false;
	}
	switch (declared.kind) {
		case "class": {
			// Walk the actual chain up to the declared class, then unify args.
			const ac = actual as typeof declared;
			for (
				let cur: (Type & { kind: "class" }) | null = ac;
				cur !== null;
				cur = instantiatedSuperclass(cur)
			) {
				if (cur.info === declared.info) {
					return declared.typeArgs.every((arg, i) =>
						unify(arg, cur.typeArgs[i], subst, solvable),
					);
				}
			}
			return false;
		}
		case "protocol": {
			return typeConforms(actual, substitute(declared, subst));
		}
		case "array":
			return unify(
				declared.element,
				(actual as typeof declared).element,
				subst,
				solvable,
			);
		case "dictionary": {
			const ad = actual as typeof declared;
			return (
				unify(declared.key, ad.key, subst, solvable) &&
				unify(declared.value, ad.value, subst, solvable)
			);
		}
		case "optional":
			return unify(
				declared.inner,
				(actual as typeof declared).inner,
				subst,
				solvable,
			);
		case "func": {
			const af = actual as FuncType;
			if (declared.params.length !== af.params.length) return false;
			if ((declared.throws ?? false) !== (af.throws ?? false)) return false;
			return (
				declared.params.every((p, i) =>
					unify(p.type, af.params[i].type, subst, solvable),
				) && unify(declared.ret, af.ret, subst, solvable)
			);
		}
		case "struct":
		case "enum":
		case "host": {
			const ai = actual as typeof declared;
			if (declared.info !== ai.info) return false;
			return declared.typeArgs.every((arg, i) =>
				unify(arg, ai.typeArgs[i], subst, solvable),
			);
		}
		default:
			return typeEquals(declared, actual);
	}
}

/** Collect unsolved type params referenced by `type`. */
export function unsolvedParams(
	type: Type,
	subst: Substitution,
	solvable: TypeParamInfo[],
): TypeParamInfo[] {
	const found: TypeParamInfo[] = [];
	const visit = (t: Type): void => {
		switch (t.kind) {
			case "typeParam":
				if (
					solvable.some((p) => p.id === t.info.id) &&
					!subst.has(t.info.id) &&
					!found.includes(t.info)
				) {
					found.push(t.info);
				}
				break;
			case "array":
				visit(t.element);
				break;
			case "dictionary":
				visit(t.key);
				visit(t.value);
				break;
			case "optional":
				visit(t.inner);
				break;
			case "func":
				for (const p of t.params) visit(p.type);
				visit(t.ret);
				break;
			case "struct":
			case "enum":
			case "class":
			case "protocol":
			case "host":
				for (const arg of t.typeArgs) visit(arg);
				break;
			case "union":
				for (const member of t.members) visit(member);
				break;
			default:
				break;
		}
	};
	visit(type);
	return found;
}
