import type { Paplico } from "@paplico/core";
import { createBuiltinBrushPresets } from "@paplico/core/brush";
import type { BrushPreset, SolidColor } from "@paplico/core/schema";

const BUILTIN_BRUSHES = createBuiltinBrushPresets();

/** Room kept between the scene and the canvas edges, in screen pixels. */
const SCENE_MARGIN = 24;

/**
 * Places the artwork a demo starts with at the canvas center and zooms out
 * until the SVG's width and height fit. The paste is dropped from the undo
 * history, so a visitor's undo never erases the scene itself.
 */
export async function seedSvg(paplico: Paplico, svg: string): Promise<void> {
	await paplico.commands.pasteSvgString(svg);
	paplico.selection.clear();
	paplico.getYjsProvider().clearUndoHistory();
	paplico.commands.updateUndoRedoState();

	const target = paplico.getPrimaryTarget();
	if (!target) return;
	const root = new DOMParser().parseFromString(
		svg,
		"image/svg+xml",
	).documentElement;
	const width = Number(root.getAttribute("width"));
	const height = Number(root.getAttribute("height"));
	const zoom = Math.min(
		1,
		(target.width - SCENE_MARGIN * 2) / width,
		(target.height - SCENE_MARGIN * 2) / height,
	);
	target.setViewport({ x: 0, y: 0, zoom });
}

export function hexToSolidColor(hex: string): SolidColor {
	const value = Number.parseInt(hex.slice(1), 16);
	return {
		type: "solid",
		color: {
			type: "rgb",
			r: ((value >> 16) & 0xff) / 255,
			g: ((value >> 8) & 0xff) / 255,
			b: (value & 0xff) / 255,
			a: 1,
		},
	};
}

/** A builtin brush preset by its English name, such as "G-Pen". */
export function builtinBrush(name: string): BrushPreset | undefined {
	return BUILTIN_BRUSHES.find((preset) => preset.name === name);
}

/** Deletes everything on the current layer. */
export function clearLayer(paplico: Paplico): void {
	const { document, currentLayerId } = paplico.uiState;
	const layer = document.layers.find((l) => l.id === currentLayerId);
	if (layer) paplico.commands.deleteElements([...layer.elementIds]);
}
