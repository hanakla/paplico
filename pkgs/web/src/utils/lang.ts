import { deepClone as _deepClone } from "valtio/utils";

export function assertNonNull<T>(
	value: T | null | undefined,
	message?: string,
): asserts value is T {
	if (value == null) {
		throw new Error(message ?? "Unexpected null value");
	}
}

type DeepMutable<T> =
	T extends ReadonlyArray<infer U>
		? DeepMutable<U>[]
		: T extends object
			? { -readonly [K in keyof T]: DeepMutable<T[K]> }
			: T;

export function deepClone<T>(obj: T): DeepMutable<T> {
	return _deepClone(obj) as DeepMutable<T>;
}
