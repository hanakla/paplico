export type Brand<T extends symbol> = { [K in T]: unknown };

export function assertNonNull<T>(
	value: T | null | undefined,
	message?: string,
): asserts value is T {
	if (value == null) {
		throw new Error(message ?? "Unexpected null value");
	}
}

/**
 * Exhaustiveness check: pass the value narrowed to `never` after every case
 * of a discriminated union is handled (e.g. the `default` branch of a
 * `switch` over every variant). If a new variant is added to the union
 * without a corresponding case, the value no longer narrows to `never` and
 * this call site becomes a type error instead of a silent no-op.
 */
export function neverReached(_v: never, message?: string): never {
	throw new Error(message ?? "This code should never be reached");
}

export { deepClone } from "valtio/utils";

export function safeJSONParse(text: string) {
	return rescue(() => JSON.parse(text));
}

type OkResult<T, _E = unknown> = {
	ok: true;
	result: T;
	error: null;
} & readonly [result: T, error: null];

type ErrResult<_T, E = unknown> = {
	ok: false;
	result: null;
	error: E;
} & readonly [result: null, error: E];

type Result<T, E = unknown> = OkResult<T, E> | ErrResult<T, E>;

export const rescue: {
	<T>(proc: () => Promise<T>): Promise<Result<T>>;
	<T>(proc: () => T): Result<T>;
	<T>(proc: () => T | Promise<T>): Promise<Result<T>> | Result<T>;
	isOk: <T, E>(r: Result<T, E>) => r is OkResult<T, E>;
	isErr: <T, E>(r: Result<T, E>) => r is ErrResult<T, E>;
} = <T>(fn: () => T | Promise<T>): any => {
	const createResult = (result: any = null, error: any = null): Result<any> =>
		Object.assign([result, error] as const, {
			ok: error == null,
			result,
			error,
		});

	try {
		const result = fn();

		if (
			result != null &&
			Object.hasOwn(result, "then") &&
			(result as any).then === "function"
		) {
			return Promise.resolve(result)
				.then((r) => createResult(r))
				.catch((e) => createResult(null, e));
		}

		return createResult(result);
	} catch (e) {
		return createResult(null, e);
	}
};

rescue.isOk = (r) => r.ok === true;
rescue.isErr = (r) => r.ok === false;
