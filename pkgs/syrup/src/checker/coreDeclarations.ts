/**
 * Type definitions of the core library, written in Syrup itself.
 * Parsed once at startup into the builtin member table (see builtins.ts).
 * The JS implementations of these members live in the emitter.
 */
export const CORE_TYPE_DECLARATIONS = `
declare type Array<T> {
	let count: Number
	let isEmpty: Bool
	let first: T?
	let last: T?
	mutating fn append(element: T) -> Void
	mutating fn insert(element: T, at index: Number) -> Void
	mutating fn remove(at index: Number) -> T
	fn contains(element: T) -> Bool
	fn map<U>(transform: (T) -> U) -> Array<U>
	fn filter(isIncluded: (T) -> Bool) -> Array<T>
	fn reduce<U>(initial: U, combine: (U, T) -> U) -> U
	fn sorted(by comparator: (T, T) -> Bool) -> Array<T>
}

declare type String {
	let count: Number
	let isEmpty: Bool
	fn uppercased() -> String
	fn lowercased() -> String
	fn contains(needle: String) -> Bool
	fn hasPrefix(prefix: String) -> Bool
	fn hasSuffix(suffix: String) -> Bool
	fn split(separator: String) -> Array<String>
}

declare type Dictionary<K, V> {
	let count: Number
	let isEmpty: Bool
	let keys: Array<K>
	let values: Array<V>
	mutating fn removeValue(forKey key: K) -> V?
}
`;
