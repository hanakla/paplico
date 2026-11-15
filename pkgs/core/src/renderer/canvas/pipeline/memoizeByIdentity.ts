/**
 * Remember what `compute` derived from each object. A frame that leaves the
 * document unchanged reuses the previous frame's objects and elements map, so
 * a whole-document scan keyed on one runs once per document revision. Only
 * derive what the key alone decides: nothing that depends on the viewport or
 * the frame.
 *
 * With `combine`, a key declared through {@link declareExtension} is derived
 * from the result of its base and a scan of what it adds, so a map that is
 * the document's plus a tool preview does not scan the document again.
 */
export function memoizeByIdentity<K extends object, T extends object>(
	compute: (key: K) => T,
	combine?: (base: T, added: T) => T,
): (key: K) => T {
	const results = new WeakMap<K, T>();
	const derive = (key: K): T => {
		const cached = results.get(key);
		if (cached) return cached;
		const extension = combine && (extensions.get(key) as Extension<K>);
		const result =
			combine && extension
				? combine(derive(extension.base), compute(extension.added))
				: compute(key);
		results.set(key, result);
		return result;
	};
	return derive;
}

/**
 * Declare that `extended` holds exactly the entries of `base` and those of
 * `added`, and that nothing in `base` refers to an entry of `added`.
 */
export function declareExtension<K extends object>(
	extended: K,
	base: K,
	added: K,
): void {
	extensions.set(extended, { base, added });
}

export function concatResults<T>(base: T[], added: T[]): T[] {
	return added.length === 0 ? base : [...base, ...added];
}

export function unionResults<T>(base: Set<T>, added: Set<T>): Set<T> {
	return added.size === 0 ? base : new Set([...base, ...added]);
}

interface Extension<K> {
	base: K;
	added: K;
}

const extensions = new WeakMap<object, Extension<object>>();
