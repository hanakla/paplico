import type { HostOps } from "./types";

/**
 * Direct in-process host ops for trusted execution (and tests). Host objects
 * are used as-is; no marshaling and no isolation.
 */
export function createInProcessOps(
	runtimeMap: Record<string, Record<string, unknown>>,
): HostOps {
	const packageMember = (pkg: string, member: string): unknown => {
		const packageRuntime = runtimeMap[pkg];
		if (!packageRuntime || !(member in packageRuntime)) {
			throw new Error(`Missing runtime binding '${pkg}.${member}'`);
		}
		return packageRuntime[member];
	};
	return {
		call(pkg, member, args) {
			const fn = packageMember(pkg, member);
			if (typeof fn !== "function") {
				throw new Error(`Runtime binding '${pkg}.${member}' is not a function`);
			}
			return fn(...args);
		},
		get(pkg, member) {
			return packageMember(pkg, member);
		},
		prop(target, name) {
			if (typeof target !== "object" || target === null) return null;
			return Reflect.get(target, name);
		},
		setProp(target, name, value) {
			if (typeof target !== "object" || target === null) return;
			Reflect.set(target, name, value);
		},
		method(target, name, args) {
			if (typeof target !== "object" || target === null) return null;
			const fn = Reflect.get(target, name);
			if (typeof fn !== "function") {
				throw new Error(`Host object has no method '${name}'`);
			}
			return Reflect.apply(fn, target, args);
		},
	};
}
