/**
 * Remember what `compute` derived from each object. A frame that leaves the
 * document unchanged reuses the previous frame's objects and elements map, so
 * a whole-document scan keyed on one runs once per document revision. Only
 * derive what the key alone decides: nothing that depends on the viewport or
 * the frame.
 */
export function memoizeByIdentity<K extends object, T extends object>(
	compute: (key: K) => T,
): (key: K) => T {
	const results = new WeakMap<K, T>();
	return (key) => {
		const cached = results.get(key);
		if (cached) return cached;
		const result = compute(key);
		results.set(key, result);
		return result;
	};
}
