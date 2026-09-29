import {
	type AnyArtObject,
	type CompoundPath,
	type ElementTransform,
	getContainerChildIds,
	isGroup,
} from "../../schema";
import {
	calculateElementBounds,
	calculateLocalElementBounds,
	calculatePathBounds,
	calculateRepeatSourceUnion,
} from "../../utils/geometry/bounds";
import {
	invertLinearMatrix,
	type LinearMatrix2x2,
	multiplyLinearMatrix,
	transformLinearMatrix,
} from "../../utils/geometry/geometry";
import type { MigrationContext } from "./context";

/**
 * Placement rules of documents older than 20260929. Every element turned
 * around a pivot of its own: the centre of its local bounds, save for the
 * types listed in legacyPivot. A group had no pivot: its transform composed
 * onto each child's and turned around the child's pivot, and mask content
 * took its owner's whole transform the same way. The sources a blend,
 * compound path, repeat or mesh absorbs pivoted inside the container's
 * space, with the chain starting over there.
 */

/**
 * Where a compound path pivoted: on the union of its sources before
 * 20260918, on its boolean result from then on.
 */
export type LegacyCompoundPivot = "sources" | "result";

interface Point {
	x: number;
	y: number;
}

/**
 * Every element's transform re-expressed under the current rule, a matrix on
 * the local origin, so that it places the element where the legacy rule drew
 * it. Elements are converted children first: a container's legacy pivot is
 * the centre of its bounds, which the current bounds code only reports once
 * the children inside it are placed the way they were drawn.
 */
export function convertLegacyPlacements(
	objects: Record<string, AnyArtObject>,
	compoundPivot: LegacyCompoundPivot,
	context: MigrationContext | undefined,
): Map<string, ElementTransform> {
	const shadow = new Map(Object.entries(objects));
	const converted = new Map<string, ElementTransform>();
	const visited = new Set<string>();

	const convert = (id: string, parent: Parent | null): void => {
		const element = objects[id];
		if (!element || visited.has(id)) return;
		visited.add(id);

		const own = element.transform;
		const linear = transformLinearMatrix(own);
		// A group's children continue its chain; every other container
		// starts a chain of its own inside its space.
		const chain =
			parent?.relation === "chain"
				? multiplyLinearMatrix(parent.chain, linear)
				: linear;
		for (const childId of getContainerChildIds(element) ?? []) {
			convert(
				childId,
				isGroup(element)
					? { relation: "chain", chain, pivot: ORIGIN }
					: { relation: "baked" },
			);
		}

		const pivot = legacyPivot(element, shadow, compoundPivot, context);
		const transform = {
			...own,
			...legacyTranslation(own, linear, pivot, parent),
		};
		shadow.set(id, { ...element, transform });
		converted.set(id, transform);

		for (const childId of element.mask?.elementIds ?? []) {
			convert(childId, { relation: "chain", chain, pivot });
		}
	};

	const parented = new Set<string>();
	for (const element of Object.values(objects)) {
		for (const childId of getContainerChildIds(element) ?? []) {
			parented.add(childId);
		}
		for (const childId of element.mask?.elementIds ?? []) {
			parented.add(childId);
		}
	}
	for (const id of Object.keys(objects)) {
		if (!parented.has(id)) convert(id, null);
	}
	// Whatever a cycle or a dangling parent kept out of the walk is placed on
	// its own.
	for (const id of Object.keys(objects)) convert(id, null);

	return converted;
}

/**
 * The centre of a compound path's sources placed inside it, where a compound
 * path pivoted before 20260918. `shadow` holds the sources under the current
 * rule (see convertLegacyPlacements). Null when no source resolves.
 */
export function legacySourceUnionCenter(
	compound: CompoundPath,
	shadow: ReadonlyMap<string, AnyArtObject>,
): Point | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const { id } of compound.sources) {
		const source = shadow.get(id);
		if (!source) continue;
		const b = calculateElementBounds(source, shadow);
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	if (minX === Number.POSITIVE_INFINITY) return null;
	return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** How an element related to the one it sits in under the legacy rule. */
type Parent =
	| {
			relation: "chain";
			/** Linear part of the chain the parent is placed under, itself included. */
			chain: LinearMatrix2x2;
			/** The parent's own legacy pivot. */
			pivot: Point;
	  }
	| { relation: "baked" };

const ORIGIN: Point = { x: 0, y: 0 };

/** The point an element turned around under the legacy rule. */
function legacyPivot(
	element: AnyArtObject,
	shadow: ReadonlyMap<string, AnyArtObject>,
	compoundPivot: LegacyCompoundPivot,
	context: MigrationContext | undefined,
): Point {
	switch (element.type) {
		case "group":
			return ORIGIN;
		case "path":
			return centerOf(calculatePathBounds(element));
		case "image":
		case "reference3d":
			return { x: element.x, y: element.y };
		case "text": {
			// A bound text pivoted on its estimate even once laid out.
			const measured = element.axisBinding
				? undefined
				: context?.textLayoutBounds.get(element.id);
			return centerOf(measured ?? calculateLocalElementBounds(element));
		}
		case "repeat":
			return centerOf(
				calculateRepeatSourceUnion(element, shadow) ??
					calculateLocalElementBounds(element, shadow),
			);
		case "compound-path":
			if (compoundPivot === "sources") {
				const union = legacySourceUnionCenter(element, shadow);
				if (union) return union;
			}
			return centerOf(calculateLocalElementBounds(element, shadow));
		default:
			return centerOf(calculateLocalElementBounds(element, shadow));
	}
}

/**
 * The translation that places the element on its local origin where the
 * legacy rule drew it around `pivot`: t + (I − L)·c, and for an element on
 * a chain, plus what turning around its own pivot instead of the parent's
 * came to inside the parent's space: (Lₓ⁻¹ − I)·(c − cₓ).
 */
function legacyTranslation(
	own: ElementTransform,
	linear: LinearMatrix2x2,
	pivot: Point,
	parent: Parent | null,
): Point {
	let x = own.x + pivot.x - (linear.m00 * pivot.x + linear.m01 * pivot.y);
	let y = own.y + pivot.y - (linear.m10 * pivot.x + linear.m11 * pivot.y);
	if (parent?.relation !== "chain") return { x, y };

	const inverse = invertLinearMatrix(parent.chain);
	if (!inverse) return { x, y };
	const dx = pivot.x - parent.pivot.x;
	const dy = pivot.y - parent.pivot.y;
	x += inverse.m00 * dx + inverse.m01 * dy - dx;
	y += inverse.m10 * dx + inverse.m11 * dy - dy;
	return { x, y };
}

function centerOf(bounds: {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}): Point {
	return {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
	};
}
