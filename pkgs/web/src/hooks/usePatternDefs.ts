import { useMemo } from "react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { DefEntry } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export function usePatternDefs(): {
	/**
	 * Every pattern-kind DefEntry in the current document, sorted by id so
	 * render order stays stable across re-renders regardless of insertion
	 * order in `document.defs`.
	 */
	list: readonly DefEntry[];
	/**
	 * Returns `"<label> <n>"` where `<label>` follows
	 * `toolbar.patternDefaultName` and `<n>` is the lowest positive integer
	 * not already used by a pattern def under the current locale's label —
	 * switching locale therefore starts a separate sequence.
	 */
	nextName: () => string;
} {
	const paplico = usePaplico();
	const snap = useSnapshot(paplico.uiState);
	const t = useTranslation();

	const list = useMemo<DefEntry[]>(() => {
		const defs = snap.document.defs ?? {};
		const out: DefEntry[] = [];
		for (const id of Object.keys(defs).sort()) {
			const entry = defs[id];
			if (entry && entry.kind === "pattern") out.push(entry as DefEntry);
		}
		return out;
	}, [snap.document.defs]);

	const nextName = useEventCallback(() => {
		const label = t("toolbar.patternDefaultName");
		const re = new RegExp(`^${RegExp.escape(label)} (\\d+)$`);
		const used = new Set<number>();
		for (const def of list) {
			const match = def.name?.match(re);
			if (match) used.add(Number.parseInt(match[1]!, 10));
		}
		let n = 1;
		while (used.has(n)) n++;
		return `${label} ${n}`;
	});

	return { list, nextName };
}
