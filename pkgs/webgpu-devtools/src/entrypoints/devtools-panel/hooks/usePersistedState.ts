import { useCallback, useEffect, useState } from "react";

export function usePersistedState<T>(
	key: string,
	defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
	const [state, setStateRaw] = useState<T>(defaultValue);

	useEffect(() => {
		browser.storage.local.get(key).then((result) => {
			if (result[key] != null) setStateRaw(result[key] as T);
		}, console.warn);
	}, [key]);

	const setState = useCallback(
		(value: T | ((prev: T) => T)) => {
			setStateRaw((prev) => {
				const next =
					typeof value === "function" ? (value as (p: T) => T)(prev) : value;
				browser.storage.local.set({ [key]: next }).catch(console.warn);
				return next;
			});
		},
		[key],
	);

	return [state, setState];
}
