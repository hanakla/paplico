import {
	type AnyArtObject,
	type AppearancePreset,
	type AppearancePresetRef,
	BUILTIN_BRUSH_IDS,
	cloneAppearance,
	type Document,
	type Filter,
	type FilterEntry,
	generateUid,
	isAppearancePresetRef,
} from "../schema";
import { deepClone } from "../utils/lang";

export type AppearancePresetMap = ReadonlyMap<string, AppearancePreset>;

export function createAppearancePresetsMap(
	doc: Pick<Document, "appearancePresets">,
): AppearancePresetMap {
	return new Map((doc.appearancePresets ?? []).map((p) => [p.uid, p]));
}

/**
 * Expand preset refs into the concrete filters they stand for.
 * Expanded filter uids are `${ref.uid}:${filter.uid}` so they stay stable
 * across frames and never collide when one preset is referenced twice.
 * Disabled or dangling refs expand to nothing.
 */
export function resolveAppearanceEntries(
	entries: readonly FilterEntry[] | undefined,
	presets: AppearancePresetMap,
): Filter[] {
	if (!entries) return [];
	const resolved: Filter[] = [];
	for (const entry of entries) {
		if (!isAppearancePresetRef(entry)) {
			resolved.push(entry);
			continue;
		}
		if (entry.enabled === false) continue;
		const preset = presets.get(entry.presetUid);
		if (!preset) continue;
		for (const filter of preset.filters) {
			const cloned = deepClone(filter);
			cloned.uid = `${entry.uid}:${filter.uid}`;
			resolved.push(cloned);
		}
	}
	return resolved;
}

/**
 * Returns a copy of the element whose filters have every preset ref expanded.
 * Returns the same reference when the element carries no refs, so callers can
 * keep identity-based caches.
 */
export function resolveElementAppearance<T extends AnyArtObject>(
	element: T,
	presets: AppearancePresetMap,
): T {
	if (!element.filters?.some(isAppearancePresetRef)) return element;
	return {
		...element,
		filters: resolveAppearanceEntries(element.filters, presets),
	};
}

/** Replace every element carrying preset refs in `elementsMap` with its resolved copy. */
export function resolveElementsMapAppearance(
	elementsMap: Map<string, AnyArtObject>,
	doc: Pick<Document, "appearancePresets">,
): void {
	if (!doc.appearancePresets?.length) return;
	const presets = createAppearancePresetsMap(doc);
	for (const [id, element] of elementsMap) {
		const resolved = resolveElementAppearance(element, presets);
		if (resolved !== element) elementsMap.set(id, resolved);
	}
}

/**
 * Apply `fn` to the concrete filters of a stack and put preset refs back at
 * their positions, so write paths that transform filters keep the refs.
 * `fn` must return one filter per input filter.
 */
export function mapLocalAppearances(
	entries: readonly FilterEntry[],
	fn: (filters: Filter[]) => Filter[],
): FilterEntry[] {
	const local = localAppearances(entries);
	const mapped = fn(local);
	if (mapped.length !== local.length) {
		throw new Error("mapLocalAppearances: fn must preserve filter count");
	}
	let next = 0;
	return entries.map((e) => (isAppearancePresetRef(e) ? e : mapped[next++]!));
}

/**
 * Build a preset from an element's resolved appearance. The preset takes every
 * non-content filter; the returned stack keeps the element's content entries
 * in place and stands a single ref where the first captured filter was.
 * Returns null when the element has nothing to capture.
 */
export function captureAppearancePreset(
	element: AnyArtObject,
	name: string,
	presets: AppearancePresetMap,
	uid = generateUid("appearance-preset"),
): { preset: AppearancePreset; filters: FilterEntry[] } | null {
	const resolved = resolveAppearanceEntries(element.filters, presets);
	const captured = resolved
		.filter((f) => f.processor !== "content")
		.map((f) => cloneAppearance(f));
	if (captured.length === 0) return null;

	const ref: AppearancePresetRef = {
		type: "preset",
		uid: generateUid("app"),
		presetUid: uid,
	};
	const filters: FilterEntry[] = [];
	let placed = false;
	for (const entry of element.filters ?? []) {
		if (!isAppearancePresetRef(entry) && entry.processor === "content") {
			filters.push(entry);
			continue;
		}
		if (placed) continue;
		filters.push(ref);
		placed = true;
	}
	return { preset: { uid, name, filters: captured }, filters };
}

/** Clones of a preset's filters, carrying the ref's enabled flag. */
export function expandAppearancePresetRef(
	ref: AppearancePresetRef,
	preset: AppearancePreset,
): Filter[] {
	return preset.filters.map((f) =>
		ref.enabled === false
			? { ...cloneAppearance(f), enabled: false }
			: cloneAppearance(f),
	);
}

/** Stack with every ref to `presetUid` replaced by its expanded filters. Same reference when nothing changed. */
export function expandAppearancePresetRefs(
	entries: readonly FilterEntry[] | undefined,
	preset: AppearancePreset,
): FilterEntry[] | undefined {
	if (
		!entries?.some(
			(e) => isAppearancePresetRef(e) && e.presetUid === preset.uid,
		)
	)
		return undefined;
	return entries.flatMap((e) =>
		isAppearancePresetRef(e) && e.presetUid === preset.uid
			? expandAppearancePresetRef(e, preset)
			: [e],
	);
}

/** Stack without refs whose preset is missing from `presets`. Same reference when nothing changed. */
export function dropDanglingPresetRefs(
	entries: readonly FilterEntry[] | undefined,
	presets: AppearancePresetMap,
): FilterEntry[] | undefined {
	if (
		!entries?.some((e) => isAppearancePresetRef(e) && !presets.has(e.presetUid))
	)
		return undefined;
	return entries.filter(
		(e) => !isAppearancePresetRef(e) || presets.has(e.presetUid),
	);
}

/** Concrete filters of a stack, ignoring preset refs. */
export function localAppearances(
	entries: readonly FilterEntry[] | undefined,
): Filter[] {
	return entries?.filter((e): e is Filter => !isAppearancePresetRef(e)) ?? [];
}

/**
 * Document-local resources a preset depends on. A preset holding any of these
 * cannot leave its document (library / JSON) because the referenced file or
 * def would not exist elsewhere. Builtin brush textures are recreated per
 * document under fixed uids, so they are portable.
 */
export function collectDocumentLocalRefs(preset: AppearancePreset): {
	fileUids: string[];
	defIds: string[];
} {
	const builtin = new Set<string>(Object.values(BUILTIN_BRUSH_IDS));
	const fileUids = new Set<string>();
	const defIds = new Set<string>();
	const walk = (value: unknown): void => {
		if (value == null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			if (key === "fileUid" && typeof v === "string") {
				if (!builtin.has(v)) fileUids.add(v);
				continue;
			}
			if (key === "defId" && typeof v === "string") {
				defIds.add(v);
				continue;
			}
			walk(v);
		}
	};
	walk(preset.filters);
	return { fileUids: [...fileUids], defIds: [...defIds] };
}
