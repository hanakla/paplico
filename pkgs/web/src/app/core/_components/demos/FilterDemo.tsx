"use client";

import type { Paplico } from "@paplico/core";
import type { AnyArtObject, FilterEntry } from "@paplico/core/schema";
import { useEffect, useState } from "react";
import { subscribe } from "valtio";
import { createDefaultFilter } from "@/organisms/FilterPanel/createDefaultFilter";
import { LiveCanvas } from "../LiveCanvas";
import { builtinBrush, hexToSolidColor, seedSvg } from "./demoSetup";
import { FILTER_SCENE } from "./scenes";

/** `params` overrides the app's defaults where those look poor on this scene. */
const EFFECTS: { processor: string; label: string; params?: object }[] = [
	{ processor: "drop-shadow", label: "Drop shadow" },
	{ processor: "hk:bloom", label: "Bloom" },
	{ processor: "hk:kirakira", label: "Sparkle" },
	{
		processor: "hk:halftone",
		label: "Halftone",
		params: {
			size: 6,
			opaqueOnly: true,
			invertDotSize: true,
			color: { type: "rgb", r: 0.04, g: 0.37, b: 0.62, a: 1 },
		},
	},
	{ processor: "hk:chromatic-aberration", label: "Chromatic aberration" },
	{ processor: "rough", label: "Rough edges" },
	{ processor: "hk:glitch", label: "Glitch" },
];

/** Marks the filters this demo owns, so toggling never touches the rest. */
const EFFECT_UID_PREFIX = "site-effect:";

/** A seeded scene whose every element carries the toggled filter stack. */
export function FilterDemo() {
	const [paplico, setPaplico] = useState<Paplico | null>(null);
	const [active, setActive] = useState<string[]>(["drop-shadow", "hk:bloom"]);

	useEffect(() => {
		if (!paplico) return;
		const effects = EFFECTS.filter((e) => active.includes(e.processor));
		applyEffects(paplico, effects);
		// Strokes drawn after a toggle get the same stack once they commit
		return subscribe(paplico.uiState.document, () =>
			applyEffects(paplico, effects),
		);
	}, [paplico, active]);

	const handleReady = async (p: Paplico) => {
		await seedSvg(p, FILTER_SCENE);
		const marker = builtinBrush("Marker");
		if (marker) p.tools.setBrushSettings(marker.settings);
		p.tools.setStrokeColor(hexToSolidColor("#ff6fae"));
		setPaplico(p);
	};

	const toggle = (processor: string) => {
		setActive((current) =>
			current.includes(processor)
				? current.filter((p) => p !== processor)
				: [...current, processor],
		);
	};

	return (
		<div className="aero-window">
			<div className="flex flex-wrap gap-2 border-b border-white/70 bg-white/40 px-3 py-2">
				{EFFECTS.map((effect) => (
					<button
						key={effect.processor}
						type="button"
						className="aero-chip"
						aria-pressed={active.includes(effect.processor)}
						onClick={() => toggle(effect.processor)}
					>
						{effect.label}
					</button>
				))}
			</div>
			<LiveCanvas
				className="h-[340px]"
				onReady={handleReady}
				hint="Toggle filters, or draw — new strokes get them too"
			/>
		</div>
	);
}

/**
 * Rewrites the demo's own filters on every element of the current layer to
 * `effects`, leaving each element's fill and stroke appearances alone.
 * The rewrite is dropped from the undo history; otherwise an undo would only
 * strip the filters, and this function would put them right back.
 */
function applyEffects(paplico: Paplico, effects: typeof EFFECTS) {
	const { document, currentLayerId } = paplico.uiState;
	const layer = document.layers.find((l) => l.id === currentLayerId);
	if (!layer) return;

	const key = effects.map((e) => e.processor).join();
	const stale = layer.elementIds.filter(
		(id) => effectKey(document.objects[id]) !== key,
	);
	if (stale.length === 0) return;

	paplico.commands.transact((commands) => {
		for (const id of stale) {
			const own = (document.objects[id]?.filters ?? []).filter(
				(entry) => !isEffect(entry),
			);
			const filters = effects.flatMap(({ processor, params }) => {
				const filter = createDefaultFilter(processor);
				if (!filter) return [];
				// The app's defaults leave these out for some processors
				return {
					...filter,
					opacity: filter.opacity ?? 1,
					blendMode: filter.blendMode ?? "normal",
					uid: `${EFFECT_UID_PREFIX}${processor}:${id}`,
					paramData: {
						...filter.paramData,
						params: { ...filter.paramData.params, ...params },
					},
				};
			});
			commands.updateElement(layer.id, id, { filters: [...own, ...filters] });
		}
	});
	paplico.getYjsProvider().clearUndoHistory();
}

function effectKey(element: AnyArtObject | undefined) {
	return (element?.filters ?? [])
		.filter(isEffect)
		.map((entry) => ("processor" in entry ? entry.processor : ""))
		.join();
}

function isEffect(entry: FilterEntry) {
	return entry.uid.startsWith(EFFECT_UID_PREFIX);
}
