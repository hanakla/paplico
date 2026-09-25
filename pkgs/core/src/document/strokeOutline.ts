import { resolveAppearancePasses } from "../renderer/canvas/elements/appearancePasses";
import {
	isOutlinableStroke,
	outlineGeometricStroke,
	resolveGeometricStrokeShape,
	strokeToFill,
} from "../renderer/canvas/elements/geometricStroke";
import {
	type FilterRenderer,
	isGeometryFilter,
} from "../renderer/canvas/pipeline/FilterRenderer";
import {
	resolveElementGeometry,
	toCompoundSourceWorldPath,
} from "../renderer/canvas/pipeline/PreFilterRenderer";
import {
	type AnyArtObject,
	type CompoundPath,
	type CubicBezierSegment,
	createDefaultContentAppearance,
	type ElementTransform,
	type Filter,
	type FilterEntry,
	type Group,
	generateUid,
	isAppearancePresetRef,
	isFilterEnabled,
	isIdentityTransform,
	type Path,
	type PathGeometry,
} from "../schema";
import { calculateLocalElementBounds } from "../utils/geometry/bounds";
import { bakeCompoundPathSegments } from "../utils/geometry/compoundBake";
import {
	composePivotedTransforms,
	computeTransformOrigin,
} from "../utils/geometry/geometry";
import {
	reconstructSegmentsFromWorld,
	transformSegmentsToWorld,
} from "../utils/geometry/segmentOps";
import { localAppearances } from "./appearancePresets";
import { createIdentityTransform, createStrokeBrushSettings } from "./factory";

/**
 * What an outlined element becomes. `root` keeps the element's id, so it
 * takes the element's place in its parent and every reference to it stays
 * valid; `children` are the new paths a group root holds. The element's
 * transform is baked into the geometry, so its mask content gets
 * `maskTransforms` to stay where it was drawn.
 */
interface StrokeOutlineResult {
	root: Path | Group;
	children: Path[];
	maskTransforms: Map<string, ElementTransform>;
}

interface OutlineDeps {
	objects: Readonly<Record<string, AnyArtObject>>;
	elementsMap: ReadonlyMap<string, AnyArtObject>;
	filterRenderer: Pick<FilterRenderer, "getHandler">;
}

/** One step of the paint order: a stroke's outline, or a paint left on the element's own shape. */
type OutlineLayer = { outline: Path } | { paint: FilterEntry };

/**
 * Whether `element` is a path or compound path with an enabled stroke for
 * outlining to act on. Strokes it cannot reproduce stay as strokes.
 */
export function canOutlineStrokes(element: AnyArtObject): boolean {
	if (element.type === "path" && element.isGuide) return false;
	if (element.type !== "path" && element.type !== "compound-path") {
		return false;
	}
	return localAppearances(element.filters).some(
		(filter) => filter.processor === "stroke" && isFilterEnabled(filter),
	);
}

/**
 * Turn every outlinable stroke of a path or compound path into a filled path
 * of its band, keeping the rest of the appearance stack. Geometry filters are
 * baked into the shapes and leave the stack. With the stroke as the only
 * paint the element stays one path; otherwise it becomes a group whose
 * children paint in the stack's order. Returns null when nothing outlines.
 */
export function buildStrokeOutline(
	element: Path | CompoundPath,
	deps: OutlineDeps,
): StrokeOutlineResult | null {
	const localSegments =
		element.type === "path"
			? element.segments
			: bakeCompoundPathSegments(
					element,
					(id) => deps.objects[id],
					(path) => toCompoundSourceWorldPath(path, deps.filterRenderer),
				);
	const entries = element.filters ?? [];
	const passes = resolveAppearancePasses(
		{
			type: "path",
			id: element.id,
			opacity: element.opacity,
			blendMode: element.blendMode,
			transform: element.transform,
			filters: entries,
			segments: localSegments,
		},
		deps.filterRenderer,
	);

	const transform = element.transform;
	const pivot = computeTransformOrigin(
		calculateLocalElementBounds(element, deps.elementsMap),
	);
	const bake = (segments: CubicBezierSegment[]) =>
		isIdentityTransform(transform)
			? segments
			: reconstructSegmentsFromWorld(
					transformSegmentsToWorld(segments, transform, pivot),
					segments,
				);
	// Only a plain path carries a width profile, an erasure or a trimmed range.
	const pathFields: Omit<PathGeometry, "segments"> =
		element.type === "path" ? element : {};

	// An outlinable stroke becomes a path of its band, an enabled paint stays
	// on the element's own shape, and everything else applies to the element
	// as a whole. `stack` is the element's stack with those strokes turned
	// into fills, for when it stays one path.
	const layers: OutlineLayer[] = [];
	const wholeElement: FilterEntry[] = [];
	const stack: FilterEntry[] = [];
	for (const entry of entries) {
		if (isAppearancePresetRef(entry)) {
			layers.push({ paint: entry });
			stack.push(entry);
			continue;
		}
		if (isGeometryFilter(entry, deps.filterRenderer)) continue;
		if (isOutlinableStroke(entry)) {
			// Geometry sub-filters are baked into the outline, so only the
			// others stay on the fill.
			const fill = strokeToFill(
				entry,
				entry.subFilters?.filter(
					(sub) => !isGeometryFilter(sub, deps.filterRenderer),
				),
			);
			stack.push(fill);
			const outline = outlineGeometricStroke(
				passes
					.filter((pass) => pass.appearance.uid === entry.uid)
					.map((pass) => pass.path.segments),
				resolveGeometricStrokeShape(
					pathFields,
					entry.paramData.params.brushSettings ?? createStrokeBrushSettings(1),
				),
				transform,
			);
			if (outline.length === 0) continue;
			layers.push({
				outline: {
					type: "path",
					id: generateUid("path"),
					opacity: 1,
					blendMode: "normal",
					transform: createIdentityTransform(),
					segments: bake(outline),
					filters: [fill],
				},
			});
			continue;
		}
		stack.push(entry);
		const isPaint = entry.processor === "fill" || entry.processor === "stroke";
		if (isPaint && isFilterEnabled(entry)) layers.push({ paint: entry });
		else wholeElement.push(entry);
	}
	if (!layers.some((layer) => "outline" in layer)) return null;

	const maskTransforms = new Map<string, ElementTransform>();
	if (!isIdentityTransform(transform)) {
		for (const id of element.mask?.elementIds ?? []) {
			const maskElement = deps.objects[id];
			if (!maskElement) continue;
			maskTransforms.set(
				id,
				composePivotedTransforms(
					transform,
					pivot,
					maskElement.transform,
					computeTransformOrigin(
						calculateLocalElementBounds(maskElement, deps.elementsMap),
					),
				),
			);
		}
	}
	const elementFields = {
		id: element.id,
		name: element.name,
		opacity: element.opacity,
		blendMode: element.blendMode,
		compositionMode: element.compositionMode,
		visible: element.visible,
		locked: element.locked,
		mask: element.mask,
		transform: createIdentityTransform(),
	};

	const [only] = layers;
	if (layers.length === 1 && "outline" in only) {
		return {
			root: { ...only.outline, ...elementFields, filters: stack },
			children: [],
			maskTransforms,
		};
	}

	// Consecutive paints share one path of the element's own shape.
	const elementGeometry = bake(
		resolveElementGeometry(
			localSegments,
			entries.filter((entry): entry is Filter => !isAppearancePresetRef(entry)),
			deps.filterRenderer,
		),
	);
	const children: Path[] = [];
	let paintPath: Path | null = null;
	for (const layer of layers) {
		if ("outline" in layer) {
			children.push(layer.outline);
			paintPath = null;
			continue;
		}
		if (paintPath) {
			paintPath.filters?.push(layer.paint);
			continue;
		}
		paintPath = {
			type: "path",
			id: generateUid("path"),
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: elementGeometry,
			filters: [layer.paint],
			strokeWidths: pathFields.strokeWidths,
			strokeWidthsBaked: pathFields.strokeWidthsBaked,
			strokeErasure: pathFields.strokeErasure,
			pathStart: pathFields.pathStart,
			pathEnd: pathFields.pathEnd,
		};
		children.push(paintPath);
	}
	return {
		root: {
			type: "group",
			...elementFields,
			childIds: children.map((child) => child.id),
			filters: [createDefaultContentAppearance(), ...wholeElement],
		},
		children,
		maskTransforms,
	};
}
