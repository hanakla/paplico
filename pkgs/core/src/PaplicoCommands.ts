/**
 * PaplicoCommands - Centralized document mutation commands
 *
 * All document mutations that go through YjsProvider are encapsulated here.
 * This class receives the DocumentStore and YjsProvider via dependency injection,
 * keeping core/ free from stores/ imports.
 */

import { createBuiltinBrushFiles } from "./brush/presets";
import type { YjsProvider } from "./collaboration/YjsProvider";
import {
	captureAppearancePreset,
	createAppearancePresetsMap,
	dropDanglingPresetRefs,
	expandAppearancePresetRef,
	expandAppearancePresetRefs,
	localAppearances,
	mapLocalAppearances,
} from "./document/appearancePresets";
import {
	areBrushSettingsSemanticallyEqual,
	FilterStackCommands,
} from "./document/FilterStackCommands";
import {
	createIdentityTransform,
	createMeshWarpObject,
	createMeshWarpObjectFromGeometry,
	createReference3DElement,
	createRepeatObject,
} from "./document/factory";
import type { SpatialIndex } from "./document/SpatialIndex";
import { buildStrokeOutline } from "./document/strokeOutline";
import { isLengthUnit, type LengthUnit } from "./document/units";
import { Clipboard } from "./infra/Clipboard";
import {
	encodeElementsPayload,
	PAPLICO_ELEMENTS_MIME,
	readClipboardElements,
} from "./io/clipboardPayload";
import type { RendererState } from "./Paplico";
import type { PaplicoSelection } from "./PaplicoSelection";
import type { FilterRenderer } from "./renderer/canvas/pipeline/FilterRenderer";
import { resolveElementGeometry } from "./renderer/canvas/pipeline/PreFilterRenderer";
import {
	cornersFromBounds,
	projectionErrorThreshold,
	projectViaH,
	solveHomography,
} from "./renderer/filters/shared/perspectiveWarp";
import {
	fitSegmentsWithProjection,
	type Point,
} from "./renderer/filters/shared/projectiveBezier";
import { setArtboardSelectionOverlay } from "./renderer/ui/overlaySink";
import {
	type AnyArtObject,
	type AppearancePreset,
	type AppearancePresetRef,
	type Artboard,
	type BlendEasing,
	type BlendMode,
	type BlendObject,
	type BlendSpacing,
	type BooleanOperation,
	type BoundingBox,
	type BrushPreset,
	type BrushSettings,
	BUILTIN_BRUSH_IDS,
	BUILTIN_PAPER_IDS,
	type Color,
	type ColorProfileSettings,
	type CompoundPath,
	type CubicBezierSegment,
	cloneAppearance,
	createDefaultContentAppearance,
	type DefEntry,
	type DefKind,
	type ElementTransform,
	type EmbeddedFile,
	type FillAppearance,
	type FillColor,
	type Filter,
	type FilterEntry,
	type Group,
	generateUid,
	getContainerChildIds,
	getTransform,
	type HdrSettings,
	type ImageObject,
	isAppearancePresetRef,
	isBlend,
	isCompoundPath,
	isContainer,
	isFreeGradient,
	isGroup,
	isIdentityTransform,
	isLinearGradient,
	isMesh,
	isMeshGradient,
	isPath,
	isRadialGradient,
	isReference3D,
	isRepeat,
	type Layer,
	type MeshArtObject,
	type MeshGradientVertex,
	type ObjectMask,
	type Path,
	type PathSegment,
	type Reference3DDef,
	type Reference3DElement,
	type Reference3DNode,
	type RepeatGridParams,
	type RepeatMirrorParams,
	type RepeatMode,
	type RepeatObject,
	type RepeatRadialParams,
	type StrokeAppearance,
	type StrokeColor,
	type TextContent,
	type TextElement,
	type Vec2,
} from "./schema";
import { generateRectangleSegments } from "./tools/ShapeTool";
import type { ToolSettings } from "./tools/toolSettings";
import type { TextRenderer } from "./typography/TextRenderer";
import { splitTextContentAt } from "./typography/textContent";
import { cloneElementsWithIdRemap } from "./utils/cloneElements";
import {
	buildElementColorUpdates,
	type CollectedColor,
	collectElementColors,
	type FilterHandlerLookup,
} from "./utils/color";
import { getFirstFill } from "./utils/elementQuery";
import {
	type AlignDelta,
	type AlignItem,
	type AlignMode,
	computeAlignDeltas,
	computeDistributeDeltas,
	type DistributeAxis,
	unionBounds,
} from "./utils/geometry/align";
import {
	computeSpineKeyPlacements,
	relocateSpineAnchorsToKeys,
} from "./utils/geometry/blendInterpolation";
import {
	brandLocalBBox,
	brandWorldBBox,
	calculateElementBounds,
	calculateLocalElementBounds,
	calculateMeshCoordinateBounds,
	calculateRepeatSourceUnion,
	translateBounds,
} from "./utils/geometry/bounds";
import {
	applyTransformToPoint,
	applyWorldAffineToTransform,
	composeTransforms,
	computeInverseCompositionTransform,
	inverseTransformVector,
	keepPointInPlace,
	placeElement,
	solveChildTransform,
	transformBounds,
} from "./utils/geometry/geometry";
import {
	deleteMeshVertex,
	demoteMeshColorVertexToDerived,
	syncDerivedVertices,
} from "./utils/geometry/meshGradient";
import { isMeshWarpPassthrough } from "./utils/geometry/meshWarp";
import {
	buildWarpGeometryFromContour,
	mapWarpGeometryPositions,
	remapWarpGeometrySrc,
	type WarpGeometry,
} from "./utils/geometry/meshWarpShape";
import { closePathAtEndpoints, type PathRun } from "./utils/geometry/pathOps";
import {
	createLocalPointDeformer,
	type DeformFrame,
	deformGradientFilters,
	flattenElementIds,
	isDeformableElement,
} from "./utils/geometry/pointDeform";
import {
	type Affine2D,
	affineToElementTransform,
	elementTransformToAffine,
	IDENTITY_AFFINE,
	invertAffine,
	isIdentityAffine,
} from "./utils/geometry/repeatInterpolation";
import {
	type AxisFlip,
	boundsRelativeMap,
	createResizeAffine,
	mapGradientFilters,
	mapSegments,
	mapWithin,
	mirrorStrokeWidths,
	resizeAxisScale,
	resizeRemainder,
	scaleStrokeFilters,
	scaleTextContent,
	scaleTextLayout,
	scaleTextStyle,
} from "./utils/geometry/resize";
import {
	getMeshWorldBoundarySegments,
	toRelativeCP1,
	toRelativeCP2,
	toWorldPath,
	translateSegments,
} from "./utils/geometry/segmentOps";
import {
	resolveSelectionFrame,
	type SelectionFrame,
} from "./utils/geometry/selectionFrame";
import { deepClone, neverReached } from "./utils/lang";
import { parseSvgToArtObjects, type SvgImportResult } from "./utils/svgImport";

/**
 * Result of createBlendFromSelection. `reason` distinguishes a user-facing
 * rejection ("different-parent": sources span multiple layers/groups) from a
 * silent no-op precondition ("invalid": locked, or fewer than two paths).
 */
type CreateBlendResult =
	| { ok: true; blendId: string }
	| { ok: false; reason: "invalid" | "different-parent" };

/**
 * Why createMeshWarpFromShapeSelection refused. Each reason maps to its own
 * user-facing message.
 */
export type MeshWarpFromShapeFailure =
	| "readonly"
	| "invalid-selection"
	| "locked"
	| "different-parent"
	| "invalid-shape"
	| "unsupported-content"
	| "invalid-bounds";

type MeshWarpFromShapeResult =
	| { ok: true; meshId: string }
	| { ok: false; reason: MeshWarpFromShapeFailure };

interface CommandContext {
	store: RendererState;
	yjsProvider: YjsProvider;
	spatial: SpatialIndex;
	isReadonly: () => boolean;
	renderElementsToPNG?: (
		elementIds: string[],
	) => Promise<{ blob: Blob } | null>;
	filterHandlerLookup?: FilterRenderer["getHandler"];
	toolSettings?: ToolSettings;
	getTextRenderer?: () => TextRenderer | null;
	selection?: PaplicoSelection;
	/** Scale filter parameters through their renderer filter handlers. */
	scaleFilters?: (
		filters: Filter[],
		scaleX: number,
		scaleY: number,
	) => Filter[];
	/** Drop the renderer's cached glyph geometry for a text element. */
	invalidateTextCache?: (elementId: string) => void;
	/**
	 * Origin to tag Yjs mutations with. Paplico wires this to return
	 * PATTERN_EDIT_ORIGIN while a pattern-edit session is active so the
	 * session-scoped UndoManager (not the main one) tracks the edit.
	 * Undefined outside of any special editing context.
	 */
	getMutationOrigin?: () => unknown;
	/**
	 * The history of the active editing session, or null outside one. Its edits
	 * carry a session origin the main UndoManager does not track, so undo has to
	 * be handed to the session that recorded them — otherwise it silently walks
	 * the document's history instead, and the session's own edits are unreachable.
	 */
	getSessionHistory?: () => {
		undo: () => boolean;
		redo: () => boolean;
		stopCapture: () => void;
	} | null;
}

export class PaplicoCommands {
	public constructor(private ctx: CommandContext) {}

	// --- Helper: get selected element ---

	private getSelectedElement(): AnyArtObject | null {
		if (this.ctx.store.selectedElementIds.length === 0) return null;
		const selectedId = this.ctx.store.selectedElementIds[0];
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return null;

		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return null;

		return this.ctx.store.document.objects[selectedId] ?? null;
	}

	private getMutationOrigin(): unknown | undefined {
		return this.ctx.getMutationOrigin?.();
	}

	/** Returns true if the current room is readonly — all mutations should be blocked. */
	private cannotMutate(): boolean {
		return this.ctx.isReadonly();
	}

	/** Returns true if the element (or its ancestor group / layer) is locked. */
	private isElementLocked(elementId: string): boolean {
		return this.ctx.spatial.isElementLocked(elementId);
	}

	/** Returns true if the given layer is locked. */
	private isLayerLocked(layerId?: string): boolean {
		const lid = layerId ?? this.ctx.store.currentLayerId;
		if (!lid) return false;
		const layer = this.ctx.store.document.layers.find((l) => l.id === lid);
		return layer?.locked === true;
	}

	/** Returns true if the current editing context (layer + scope stack) is locked. */
	private isCurrentContextLocked(): boolean {
		if (this.isLayerLocked()) return true;

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		if (editingScopeId && this.isElementLocked(editingScopeId)) return true;
		return false;
	}

	// --- Element Operations ---

	public addPath(path: Path): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;

		if (!this.ctx.store.currentLayerId) {
			console.warn("No layer selected, cannot add path");
			return;
		}

		const layerId = this.ctx.store.currentLayerId;
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(layerId, path, this.getMutationOrigin());
			this.moveIntoEditingScope(layerId, path);
		}, this.getMutationOrigin());
	}

	public addImage(image: ImageObject): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		if (!this.ctx.store.currentLayerId) {
			console.warn("No layer selected, cannot add image");
			return;
		}

		const layerId = this.ctx.store.currentLayerId;
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(layerId, image, this.getMutationOrigin());
			this.moveIntoEditingScope(layerId, image);
		}, this.getMutationOrigin());
	}

	public addText(text: TextElement): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		if (!this.ctx.store.currentLayerId) {
			console.warn("No layer selected, cannot add text");
			return;
		}

		const layerId = this.ctx.store.currentLayerId;
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(layerId, text, this.getMutationOrigin());
			this.moveIntoEditingScope(layerId, text);
		}, this.getMutationOrigin());
	}

	/**
	 * Moves a just-added layer-root element into the editing scope container,
	 * keeping it where it is drawn (see moveIntoContainer).
	 */
	private moveIntoEditingScope(layerId: string, moved: AnyArtObject): void {
		this.moveIntoContainer(layerId, moved, this.getEditingScopeContainerId());
	}

	/**
	 * Moves a layer-root element into the given container, compensating its
	 * transform so its world-space appearance is preserved. A null container
	 * leaves the element at the layer root. `elementsMap` resolves what the
	 * element is built from when that is not in the document yet.
	 */
	private moveIntoContainer(
		layerId: string,
		moved: AnyArtObject,
		targetContainerId: string | null,
		elementsMap?: ReadonlyMap<string, AnyArtObject>,
	): void {
		if (!targetContainerId) return;

		const container = this.ctx.store.document.objects[targetContainerId];
		if (!container) return;
		// A compound path takes only paths; anything else stays at the layer root.
		if (isCompoundPath(container) && moved.type !== "path") return;

		const matrix = this.ctx.spatial.getChildrenMatrix(targetContainerId);
		if (matrix && !isIdentityTransform(matrix)) {
			this.ctx.yjsProvider.updateElement(
				layerId,
				moved.id,
				{
					transform: solveChildTransform(matrix, getTransform(moved)),
				} as Partial<AnyArtObject>,
				this.getMutationOrigin(),
			);
		}

		if (isCompoundPath(container)) {
			this.ctx.yjsProvider.addSourceToCompoundPath(
				layerId,
				targetContainerId,
				moved.id,
				"union",
				this.getMutationOrigin(),
			);
		} else {
			this.ctx.yjsProvider.addElementToGroup(
				layerId,
				targetContainerId,
				moved.id,
				this.getMutationOrigin(),
			);
		}
	}

	/**
	 * The container that receives elements added while an editing scope is
	 * active, or null when they stay at the layer root.
	 */
	private getEditingScopeContainerId(): string | null {
		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		if (!editingScopeId) return null;

		const scopeElement = this.ctx.store.document.objects[editingScopeId];
		if (!scopeElement) return null;

		// Single-element scope: new elements go to the scope element's own
		// parent — its ancestor container, or the layer root where addElement
		// already placed them (in which case there is nothing to move).
		return isContainer(scopeElement)
			? editingScopeId
			: this.ctx.spatial.getParentGroupId(editingScopeId);
	}

	public updateElement(
		layerId: string,
		elementId: string,
		updates: Partial<AnyArtObject>,
	): void {
		if (this.isElementLocked(elementId)) return;
		this.writeElement(layerId, elementId, updates);
	}

	/**
	 * Write `updates` to an element without asking its lock. For a write that
	 * belongs to an operation whose target the caller already checked: a
	 * container handing a change down to its content, or a tool committing the
	 * gesture it judged when the gesture began.
	 */
	public writeElement(
		layerId: string,
		elementId: string,
		updates: Partial<AnyArtObject>,
	): void {
		if (this.cannotMutate()) return;

		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;

		// The sync chain drops a text's measured layout for the estimate, so it
		// is read before the update and put back after: a move or a transform
		// edit leaves the layout as it was, and the renderer measures it again
		// once the content, style or layout changed.
		const before =
			element.type === "text"
				? {
						measured: this.ctx.spatial.getLocalBounds(elementId),
						x: element.x,
						y: element.y,
					}
				: null;

		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			updates,
			this.getMutationOrigin(),
		);

		const updated = this.ctx.store.document.objects[elementId];
		if (!before?.measured || updated?.type !== "text") return;
		const local = brandLocalBBox(
			translateBounds(
				before.measured,
				updated.x - before.x,
				updated.y - before.y,
			),
		);
		this.ctx.spatial.setTextBounds(
			elementId,
			brandWorldBBox(transformBounds(local, getTransform(updated))),
			local,
		);
	}

	public deleteElements(elementIds: string[]): void {
		if (this.cannotMutate()) return;

		elementIds = elementIds.filter((id) => !this.isElementLocked(id));
		if (elementIds.length === 0) return;

		const objects = this.ctx.store.document.objects;
		const deleteSet = new Set(elementIds.filter((id) => objects[id]));
		if (deleteSet.size === 0) return;

		// A container's children and an element's mask content are absorbed:
		// they live only in document.objects and are reachable only through
		// their owner, so they go with it or they linger as orphans.
		const stack = [...deleteSet];
		for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
			const obj = objects[id];
			if (!obj) continue;
			for (const ownedId of [
				...(getContainerChildIds(obj) ?? []),
				...(obj.mask?.elementIds ?? []),
			]) {
				if (deleteSet.has(ownedId)) continue;
				deleteSet.add(ownedId);
				stack.push(ownedId);
			}
		}

		const origin = this.getMutationOrigin();

		// Detach text bindings / flow links that reference deleted elements
		// (same origin so one undo restores both the deletion and the cleanup)
		this.cleanupTextReferencesForDelete(deleteSet, origin);

		// Find elements in layer.elementIds (top-level)
		const byLayer: Record<string, string[]> = {};
		for (const layer of this.ctx.store.document.layers) {
			const matched = layer.elementIds.filter((id) => deleteSet.has(id));
			if (matched.length > 0) byLayer[layer.id] = matched;
		}

		// Find elements inside group.childIds (nested)
		const foundInLayer = new Set(Object.values(byLayer).flat());
		const remaining = [...deleteSet].filter((id) => !foundInLayer.has(id));

		// Surviving groups, meshes and compound paths drop the deleted ids from
		// their child lists.
		const byContainer: Record<string, string[]> = {};
		if (remaining.length > 0) {
			const remainSet = new Set(remaining);
			for (const obj of Object.values(objects)) {
				if (!obj || deleteSet.has(obj.id)) continue;
				const childIds =
					isGroup(obj) || isMesh(obj)
						? obj.childIds
						: isCompoundPath(obj)
							? obj.sources.map((s) => s.id)
							: [];
				const matched = childIds.filter((id) => remainSet.has(id));
				if (matched.length > 0) {
					byContainer[obj.id] = matched;
					for (const id of matched) remainSet.delete(id);
				}
				if (remainSet.size === 0) break;
			}
		}

		if (
			Object.keys(byLayer).length === 0 &&
			Object.keys(byContainer).length === 0
		)
			return;

		// Update parent containers' child lists before deleting objects
		for (const [containerId, ids] of Object.entries(byContainer)) {
			const container = this.ctx.store.document.objects[containerId];
			const idsToRemove = new Set(ids);
			const updates: Partial<AnyArtObject> = isCompoundPath(container)
				? {
						sources: container.sources.filter((s) => !idsToRemove.has(s.id)),
					}
				: {
						childIds: (container as Group | MeshArtObject).childIds.filter(
							(id) => !idsToRemove.has(id),
						),
					};
			this.ctx.yjsProvider.updateElement("", containerId, updates, origin);
		}

		// Delete objects from yDoc + remove from layer elementIds
		// yjsProvider.deleteElements deletes from yObjects for ALL ids,
		// and removes from layer.elementIds where found (no-op for absorbed ids)
		const currentLayerId = this.ctx.store.currentLayerId ?? "";
		const allByLayer = { ...byLayer };
		if (remaining.length > 0) {
			allByLayer[currentLayerId] = [
				...(allByLayer[currentLayerId] ?? []),
				...remaining,
			];
		}

		this.ctx.yjsProvider.deleteElements(allByLayer, origin);
	}

	/**
	 * Reference cleanup before deleting elements:
	 * - Texts bound to a deleted axis path lose their binding (plain text)
	 * - Flow links pointing at deleted regions are spliced past them
	 * - A deleted head's content is promoted into the first surviving region
	 * Guide-ified axis paths keep their hidden appearance; unbinding does not
	 * restore them.
	 */
	private cleanupTextReferencesForDelete(
		deleteSet: Set<string>,
		origin: unknown,
	): void {
		const objects = this.ctx.store.document.objects;

		for (const obj of Object.values(objects)) {
			if (obj?.type !== "text" || deleteSet.has(obj.id)) continue;

			const updates: Partial<TextElement> = {};
			let dirty = false;

			if (obj.axisBinding && deleteSet.has(obj.axisBinding.pathObjectId)) {
				updates.axisBinding = undefined;
				dirty = true;
			}

			if (
				obj.flow?.nextTextElementId &&
				deleteSet.has(obj.flow.nextTextElementId)
			) {
				const next = this.firstSurvivingFlowTarget(
					obj.flow.nextTextElementId,
					deleteSet,
				);
				updates.flow = next ? { nextTextElementId: next } : undefined;
				dirty = true;
			}

			if (dirty) {
				this.ctx.yjsProvider.updateElement(
					"",
					obj.id,
					updates as Partial<AnyArtObject>,
					origin,
				);
			}
		}

		for (const id of deleteSet) {
			const obj = objects[id];
			if (obj?.type !== "text") continue;

			// Head promotion: only heads hold content in a flow chain
			const holdsContent = obj.content.paragraphs.some((p) =>
				p.runs.some((r) => r.text.length > 0),
			);
			if (holdsContent && obj.flow?.nextTextElementId) {
				const successorId = this.firstSurvivingFlowTarget(
					obj.flow.nextTextElementId,
					deleteSet,
				);
				const successor = successorId ? objects[successorId] : undefined;
				if (successor?.type === "text") {
					this.ctx.yjsProvider.updateElement(
						"",
						successor.id,
						{
							content: obj.content,
							defaultStyle: obj.defaultStyle,
						} as Partial<AnyArtObject>,
						origin,
					);
				}
			}
		}
	}

	/** Follow flow links past deleted regions to the first surviving target */
	private firstSurvivingFlowTarget(
		startId: string,
		deleteSet: Set<string>,
	): string | undefined {
		const objects = this.ctx.store.document.objects;
		let next: string | undefined = startId;
		const visited = new Set<string>();
		while (next && deleteSet.has(next) && !visited.has(next)) {
			visited.add(next);
			const target = objects[next];
			next =
				target?.type === "text" ? target.flow?.nextTextElementId : undefined;
		}
		return next && !deleteSet.has(next) ? next : undefined;
	}

	public toggleElementVisibility(layerId: string, elementId: string): void {
		this.setElementVisibility(
			layerId,
			elementId,
			this.ctx.store.document.objects[elementId]?.visible === false,
		);
	}

	/**
	 * Show or hide an element. Visibility is how the document is viewed, not
	 * an edit of the element, so a lock does not hold it back.
	 */
	public setElementVisibility(
		layerId: string,
		elementId: string,
		visible: boolean,
	): void {
		if (this.cannotMutate()) return;
		if (!this.ctx.store.document.objects[elementId]) return;

		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			{ visible },
			this.getMutationOrigin(),
		);
	}

	public toggleElementLock(layerId: string, elementId: string): void {
		if (this.cannotMutate()) return;
		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;
		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			{ locked: !element.locked },
			this.getMutationOrigin(),
		);
	}

	/** Lock every given element in a single undo step. */
	public lockElements(elementIds: string[]): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const elementId of elementIds) {
				this.ctx.yjsProvider.updateElement(
					layerId,
					elementId,
					{ locked: true },
					origin,
				);
			}
		}, origin);
	}

	/** Hide every given unlocked element in a single undo step. */
	public hideElements(elementIds: string[]): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const elementId of elementIds) {
				if (this.isElementLocked(elementId)) continue;
				this.ctx.yjsProvider.updateElement(
					layerId,
					elementId,
					{ visible: false },
					origin,
				);
			}
		}, origin);
	}

	// --- Layer Operations ---

	public addLayer(layer: Layer): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addLayer(layer);
		this.ctx.store.currentLayerId = layer.id;
	}

	public deleteLayer(layerId: string): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.deleteLayer(layerId);

		if (this.ctx.store.currentLayerId === layerId) {
			if (this.ctx.store.document.layers.length > 0) {
				this.ctx.store.currentLayerId = this.ctx.store.document.layers[0].id;
			} else {
				this.ctx.store.currentLayerId = null;
			}
		}
	}

	public reorderLayers(oldIndex: number, newIndex: number): void {
		if (this.cannotMutate()) return;
		const layerCount = this.ctx.store.document.layers.length;
		if (
			oldIndex < 0 ||
			newIndex < 0 ||
			oldIndex >= layerCount ||
			newIndex >= layerCount ||
			oldIndex === newIndex
		) {
			return;
		}
		this.ctx.yjsProvider.reorderLayers(oldIndex, newIndex);
	}

	public toggleLayerVisibility(layerId: string): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			visible: !layer.visible,
		});
	}

	public toggleLayerLock(layerId: string): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;
		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			locked: !layer.locked,
		});
	}

	public renameLayer(layerId: string, name: string): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, { name });
	}

	public updateLayer(layerId: string, updates: Partial<Layer>): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find(
			(item) => item.id === layerId,
		);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, updates);
	}

	public updateLayerBlendMode(layerId: string, blendMode: BlendMode): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			blendMode,
		});
	}

	public updateLayerOpacity(layerId: string, opacity: number): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			opacity,
		});
	}

	// --- Movement Operations ---

	public moveElementForward(elementId: string): void {
		this.moveElementBy(elementId, 1);
	}

	public moveElementBackward(elementId: string): void {
		this.moveElementBy(elementId, -1);
	}

	/**
	 * Swap the element with its neighbor inside whatever holds it directly, so
	 * arranging keeps working on a group member while that group is being edited.
	 */
	private moveElementBy(elementId: string, delta: 1 | -1): void {
		if (this.cannotMutate()) return;
		if (this.isElementLocked(elementId)) return;
		const document = this.ctx.store.document;
		const containerId = findDirectContainerId(document, elementId);
		if (containerId == null) return;
		const siblingIds = containerChildIds(document, containerId);
		const elementIndex = siblingIds.indexOf(elementId);
		const targetIndex = elementIndex + delta;
		if (elementIndex < 0 || targetIndex < 0) return;
		if (targetIndex >= siblingIds.length) return;

		if (document.layers.some((l) => l.id === containerId)) {
			this.reorderElements(containerId, elementIndex, targetIndex);
			return;
		}
		this.ctx.yjsProvider.reorderGroupChildren(
			containerId,
			elementIndex,
			targetIndex,
		);
	}

	public extractSourceFromCompoundPath(
		compoundPathId: string,
		elementId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(compoundPathId)) return;
		this.ctx.yjsProvider.extractSourceFromCompoundPath(
			compoundPathId,
			elementId,
			layerId,
			insertIndex,
		);
	}

	public reorderCompoundPathSource(
		compoundPathId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(compoundPathId)) return;
		this.ctx.yjsProvider.reorderCompoundPathSource(
			compoundPathId,
			fromIndex,
			toIndex,
		);
	}

	public extractChildFromGroup(
		groupId: string,
		childId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(groupId)) return;
		const child = this.ctx.store.document.objects[childId];
		// The child lands directly in the layer, so every ancestor's transform
		// moves into its own to keep it drawn where it was.
		const ancestorT = this.ctx.spatial.getAncestorTransform(childId);

		this.transact(() => {
			if (child && ancestorT) {
				this.ctx.yjsProvider.updateElement(
					layerId,
					childId,
					{ transform: composeTransforms(ancestorT, getTransform(child)) },
					this.getMutationOrigin(),
				);
			}
			this.ctx.yjsProvider.extractChildFromGroup(
				groupId,
				childId,
				layerId,
				insertIndex,
			);
		});
	}

	public reorderGroupChildren(
		groupId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(groupId)) return;
		this.ctx.yjsProvider.reorderGroupChildren(groupId, fromIndex, toIndex);
	}

	/**
	 * Extract a source out of a blend into a layer. Extracting the spine is not
	 * supported here. When removing the source would leave the blend with fewer
	 * than 2 sources (its minimum), the whole blend is released instead.
	 */
	public extractChildFromBlend(
		blendId: string,
		childId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;
		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;
		if (childId === blend.spineSourceId) return;
		if (!blend.objectIds.includes(childId)) return;
		if (blend.objectIds.length - 1 < 2) {
			this.releaseBlend(blendId);
			return;
		}
		this.ctx.yjsProvider.extractChildFromBlend(
			blendId,
			childId,
			layerId,
			insertIndex,
		);
	}

	/** Reorder a blend's sources (its draw order). Spine/key positions unchanged. */
	public reorderBlendChildren(
		blendId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;
		this.ctx.yjsProvider.reorderBlendChildren(blendId, fromIndex, toIndex);
	}

	public reorderElements(
		layerId: string,
		oldIndex: number,
		newIndex: number,
	): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.reorderElements(
			layerId,
			oldIndex,
			newIndex,
			this.getMutationOrigin(),
		);
	}

	public moveElementToLayer(
		sourceLayerId: string,
		elementIndex: number,
		targetLayerId: string,
		targetIndex?: number,
	): void {
		if (this.cannotMutate()) return;
		const sourceLayer = this.ctx.store.document.layers.find(
			(l) => l.id === sourceLayerId,
		);
		if (!sourceLayer) return;
		if (elementIndex < 0 || elementIndex >= sourceLayer.elementIds.length)
			return;

		const elementId = sourceLayer.elementIds[elementIndex];
		if (this.isElementLocked(elementId)) return;
		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;

		this.ctx.yjsProvider.moveElementToLayer(
			sourceLayerId,
			elementId,
			targetLayerId,
			targetIndex,
			this.getMutationOrigin(),
		);
	}

	// --- Group Operations ---

	private addSvgImport(result: SvgImportResult): string[] {
		if (this.cannotMutate()) return [];
		if (!this.ctx.store.currentLayerId || result.topLevelIds.length === 0)
			return [];
		this.ctx.yjsProvider.addSvgImport(
			this.ctx.store.currentLayerId,
			result.objects,
			result.files,
			result.topLevelIds,
			result.defs,
		);
		return result.topLevelIds;
	}

	public groupSelectedElements(elementIds: string[]): string | null {
		if (this.cannotMutate()) return null;
		elementIds = elementIds.filter((id) => !this.isElementLocked(id));

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		if (editingScopeId) {
			// Inside an editing scope, the selection lives in the parent group's
			// childIds (not in any layer's elementIds). Group within the parent,
			// keeping the children's stacking (z) order regardless of selection
			// order.
			const parentGroup = this.ctx.store.document.objects[editingScopeId];
			if (!parentGroup || !isGroup(parentGroup)) return null;

			const selectedWithIndex = elementIds
				.map((id) => ({ id, index: parentGroup.childIds.indexOf(id) }))
				.filter((item) => item.index !== -1);
			if (selectedWithIndex.length < 2) return null;

			selectedWithIndex.sort((a, b) => a.index - b.index);

			const groupId = this.ctx.yjsProvider.groupElementsInGroup(
				editingScopeId,
				selectedWithIndex.map((item) => item.id),
				this.getMutationOrigin(),
			);
			if (!groupId) return null;

			this.ctx.store.selectedElementIds = [groupId];
			return groupId;
		}

		const selectedSet = new Set(elementIds);
		const positionedSelection: Array<{
			id: string;
			layerId: string;
			layerIndex: number;
			elementIndex: number;
		}> = [];

		for (
			let layerIndex = 0;
			layerIndex < this.ctx.store.document.layers.length;
			layerIndex++
		) {
			const layer = this.ctx.store.document.layers[layerIndex];
			for (
				let elementIndex = 0;
				elementIndex < layer.elementIds.length;
				elementIndex++
			) {
				const id = layer.elementIds[elementIndex];
				if (!selectedSet.has(id)) continue;
				if (!this.ctx.store.document.objects[id]) continue;
				positionedSelection.push({
					id,
					layerId: layer.id,
					layerIndex,
					elementIndex,
				});
			}
		}

		if (positionedSelection.length < 2) return null;

		positionedSelection.sort((a, b) => {
			if (a.layerIndex !== b.layerIndex) {
				return a.layerIndex - b.layerIndex;
			}
			return a.elementIndex - b.elementIndex;
		});

		const topmost = positionedSelection.at(-1);
		if (!topmost) return null;

		const targetLayerId = topmost.layerId;
		const orderedIds = positionedSelection.map((item) => item.id);

		for (const item of positionedSelection) {
			if (item.layerId === targetLayerId) continue;

			this.ctx.yjsProvider.moveElementToLayer(
				item.layerId,
				item.id,
				targetLayerId,
				undefined,
				this.getMutationOrigin(),
			);
		}

		const groupId = this.ctx.yjsProvider.groupElements(
			targetLayerId,
			orderedIds,
			this.getMutationOrigin(),
		);
		if (!groupId) return null;

		this.ctx.store.currentLayerId = targetLayerId;
		this.ctx.store.selectedElementIds = [groupId];

		return groupId;
	}

	/**
	 * Replace a text element with a group containing outlined paths.
	 * Delegates the atomic Yjs mutation to YjsProvider.
	 */
	private outlineTextElement(
		layerId: string,
		textElementId: string,
		paths: Path[],
		group: Group,
	): void {
		if (this.cannotMutate() || this.isElementLocked(textElementId)) return;
		this.ctx.yjsProvider.outlineTextElement(
			layerId,
			textElementId,
			paths,
			group,
		);
	}

	/**
	 * Convert text elements to outlined path groups.
	 * Each text element becomes an independent group containing its glyph paths
	 * plus the original (hidden) text element.
	 */
	public async outlineTextElements(elementIds: string[]): Promise<string[]> {
		const textRenderer = this.ctx.getTextRenderer?.();
		if (!textRenderer) return [];

		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return [];

		const newGroupIds: string[] = [];

		for (const elementId of elementIds) {
			const element = this.ctx.store.document.objects[elementId];
			if (!element || element.type !== "text") continue;

			const textElement = element;
			const result = await textRenderer.textElementToOutlinedPaths(textElement);

			if (result.outlinedPaths.length === 0) continue;

			// Apply per-character paint from source Run styles. Runs and styles
			// live on the flow-chain head; flow targets have empty content.
			const paintSource = textRenderer.getFlowHead(textElement);
			const paths: Path[] = result.outlinedPaths.map(
				({ path, runIndex, paragraphIndex }) => {
					const run =
						paintSource.content.paragraphs[paragraphIndex]?.runs[runIndex];
					const style = run?.style ?? paintSource.defaultStyle;

					const fill = style.fill ?? paintSource.defaultStyle.fill ?? null;
					const stroke =
						style.stroke ?? paintSource.defaultStyle.stroke ?? null;

					const filters: Filter[] = [];
					if (fill) {
						filters.push({
							uid: generateUid("app"),
							processor: "fill",
							paramData: { version: "1", params: { fill } },
						} as FillAppearance);
					}
					if (stroke) {
						filters.push({
							uid: generateUid("app"),
							processor: "stroke",
							paramData: {
								version: "1",
								params: {
									strokeColor: stroke,
								},
							},
						} as StrokeAppearance);
					}

					return { ...path, filters };
				},
			);

			const group: Group = {
				type: "group",
				id: generateUid("group"),
				childIds: [...paths.map((p) => p.id), textElement.id],
				opacity: textElement.opacity,
				blendMode: textElement.blendMode,
				transform: textElement.transform,
				name: "Outlined Text",
				filters: [createDefaultContentAppearance()],
			};

			this.outlineTextElement(layerId, textElement.id, paths, group);
			newGroupIds.push(group.id);
		}

		if (newGroupIds.length > 0) {
			this.ctx.store.selectedElementIds = newGroupIds;
		}
		return newGroupIds;
	}

	/**
	 * Outline the given elements and select what they became: text turns into
	 * glyph paths, and paths and compound paths turn their geometric strokes
	 * into filled shapes (see buildStrokeOutline).
	 */
	public async outlineElements(elementIds: string[]): Promise<string[]> {
		const { objects } = this.ctx.store.document;
		const textIds = elementIds.filter((id) => objects[id]?.type === "text");
		const outlinedIds = await this.outlineTextElements(textIds);

		const deps = {
			objects,
			elementsMap: new Map(Object.entries(objects)),
			filterRenderer: {
				getHandler: (processor: string) =>
					this.ctx.filterHandlerLookup?.(processor),
			},
		};
		const replacements: AnyArtObject[] = [];
		const maskTransforms = new Map<string, ElementTransform>();
		for (const id of elementIds) {
			const element = objects[id];
			if (element?.type !== "path" && element?.type !== "compound-path") {
				continue;
			}
			if (this.cannotMutate() || this.isElementLocked(id)) continue;
			const result = buildStrokeOutline(element, deps);
			if (!result) continue;
			replacements.push(result.root, ...result.children);
			for (const [maskId, transform] of result.maskTransforms) {
				maskTransforms.set(maskId, transform);
			}
			outlinedIds.push(id);
		}
		if (replacements.length > 0) {
			this.ctx.yjsProvider.replaceObjects(
				replacements,
				maskTransforms,
				this.getMutationOrigin(),
			);
		}

		if (outlinedIds.length > 0) {
			this.ctx.store.selectedElementIds = outlinedIds;
		}
		return outlinedIds;
	}

	public ungroupElements(groupId: string): void {
		if (this.cannotMutate() || this.isElementLocked(groupId)) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		const objects = this.ctx.store.document.objects;
		const group = objects[groupId];

		this.transact(() => {
			// The group places its children under its own transform, so that
			// transform moves into every child to keep it drawn where it was.
			// Locked children move too: the lock guards their own editing, not
			// the group they belong to.
			if (
				group &&
				isGroup(group) &&
				!isIdentityTransform(getTransform(group))
			) {
				const childrenMatrix = placeElement(null, group);
				this.ctx.yjsProvider.batchUpdateElements(
					group.childIds.flatMap((childId) => {
						const child = objects[childId];
						if (!child) return [];
						const transform = placeElement(childrenMatrix, child);
						return [{ elementId: childId, updates: { transform } }];
					}),
					this.getMutationOrigin(),
				);
			}
			this.ctx.yjsProvider.ungroupElements(layerId, groupId);
		});
	}

	// --- Compound Path Operations ---

	public createCompoundPathFromSelection(
		operation: BooleanOperation,
	): string | null {
		if (this.cannotMutate()) return null;

		const selectedPaths = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is Path => el !== undefined && isPath(el));

		if (selectedPaths.length < 2) {
			console.warn("Need at least 2 paths to create compound path");
			return null;
		}

		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedPaths.map((p) => p.id),
		);
		if (!owner.ok) return null;

		const sources = selectedPaths.map((p) => ({ id: p.id, op: operation }));
		const firstPath = selectedPaths[0];

		const compoundPathId = `compound-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const compoundPath: CompoundPath = {
			type: "compound-path",
			id: compoundPathId,
			sources,
			filters: firstPath.filters ? [...firstPath.filters] : [],
			opacity: firstPath.opacity,
			blendMode: firstPath.blendMode,
			transform: createIdentityTransform(),
		};

		const parent = this.ctx.store.document.objects[owner.parentId];
		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.createCompoundPath(
				owner.parentId,
				compoundPath,
				origin,
			);
			// Absorbing the clip path would leave the group clipped by an element
			// that no longer sits in it, so the compound takes over the clip.
			if (
				parent &&
				isGroup(parent) &&
				sources.some((s) => s.id === parent.clipPathId)
			) {
				this.setClipPathForGroup(parent.id, compoundPathId);
			}
		}, origin);
		this.ctx.store.selectedElementIds = [compoundPathId];

		return compoundPathId;
	}

	// --- Blend Operations ---

	/**
	 * Create a blend from the selected paths / compound-paths (≥2; other types
	 * ignored). The sources are absorbed: removed from the layer with the blend
	 * taking the topmost source's position. Returns the new blend id, or null.
	 */
	public createBlendFromSelection(
		spacing: BlendSpacing = { type: "steps", count: 5 },
	): CreateBlendResult {
		if (this.cannotMutate()) return { ok: false, reason: "invalid" };

		const selectedSources = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter(
				(el): el is Path | CompoundPath =>
					el !== undefined && (isPath(el) || isCompoundPath(el)),
			);

		if (selectedSources.length < 2) {
			console.warn("Need at least 2 paths/compound-paths to create a blend");
			return { ok: false, reason: "invalid" };
		}

		// Every source must share one parent container: all top-level siblings of
		// the same layer, or all children of the same single group. Mixed parents
		// (different layers, different groups, or layer+group) are rejected —
		// absorbing/restoring across containers would be lossy and the renderer
		// would draw an unabsorbed source twice.
		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedSources.map((s) => s.id),
		);
		if (!owner.ok) return owner;

		// Normalize the source order to the parent container's stacking (z) order
		// so the blend paints keys/intermediates back-to-front matching the layer,
		// not the (spatial/marquee) selection order. Both the spine (built through
		// the key centers in order) and objectIds derive from this array, so they
		// stay in sync. Use reverseBlend to flip afterwards.
		const orderedSources = orderSourcesByContainer(
			this.ctx.store.document,
			owner.parentId,
			selectedSources,
		);

		// Auto-create the default spine: a polyline through the key centers (in
		// order). The keys are its vertices, so the keys keep their positions and
		// the spine bends through them. It is absorbed (kept in document.objects,
		// not drawn directly) — an editable guide along which intermediates flow.
		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		const spinePath = buildBlendSpineThroughKeys(orderedSources, elementsMap);

		const blendId = generateUid("blend");
		const blend: BlendObject = {
			type: "blend",
			id: blendId,
			objectIds: orderedSources.map((s) => s.id),
			spacing,
			placementEasing: { type: "linear" },
			appearanceEasing: { type: "linear" },
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			spineSourceId: spinePath?.id,
		};

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			if (spinePath) this.ctx.yjsProvider.addObjectOnly(spinePath, origin);
			this.ctx.yjsProvider.createBlend(owner.parentId, blend);
		}, origin);
		this.ctx.store.selectedElementIds = [blendId];

		return { ok: true, blendId };
	}

	/**
	 * Lay the blend keys out along the spine by POSITION (no rotation — keys keep
	 * their authored orientation): key i is translated so its center sits at the
	 * spine point at equal arc-length i/(N-1). Baked into each key's own transform
	 * (stored == drawn) so the keys stay editable in place.
	 */
	private reflowBlendKeysOntoSpine(
		keys: AnyArtObject[],
		spineSource: Path,
		origin: unknown,
	): void {
		const placements = computeSpineKeyPlacements(spineSource, keys.length);
		if (!placements) return;

		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		keys.forEach((key, i) => {
			const local = calculateLocalElementBounds(key, elementsMap);
			const olx = (local.minX + local.maxX) / 2;
			const oly = (local.minY + local.maxY) / 2;
			const st = getTransform(key);
			const p = placements[i];
			this.ctx.yjsProvider.updateElement(
				"",
				key.id,
				{
					transform: { ...st, x: p.x - olx, y: p.y - oly },
				} as Partial<AnyArtObject>,
				origin,
			);
		});
	}

	/**
	 * Re-lay every blend's keys whose spine is `spineId`. Called after the spine
	 * path's geometry changes (e.g. edited in PathEditTool) so the keys live-follow
	 * the spine and re-distribute along it.
	 */
	public reflowBlendsForSpine(spineId: string): void {
		const spineSource = this.ctx.store.document.objects[spineId];
		if (!spineSource || !isPath(spineSource)) return;

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const obj of Object.values(this.ctx.store.document.objects)) {
				if (!isBlend(obj) || obj.spineSourceId !== spineId) continue;
				const keys = obj.objectIds
					.map((id) => this.ctx.store.document.objects[id])
					.filter((el): el is AnyArtObject => el !== undefined);
				this.reflowBlendKeysOntoSpine(keys, spineSource, origin);
			}
		}, origin);
	}

	/**
	 * If `pathId` is a key of any blend, reshape that blend's spine so it passes
	 * through the (moved) keys again — the spine = polyline through key centers.
	 * Called after a key's geometry changes (e.g. moved in PathEditTool) so the
	 * spine live-follows the key. Updates spine segments only (not via pathUpdate),
	 * so it does not re-trigger key reflow.
	 */
	public rebuildBlendSpineIfKey(pathId: string): void {
		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const obj of Object.values(this.ctx.store.document.objects)) {
				if (!isBlend(obj) || !obj.spineSourceId) continue;
				if (!obj.objectIds.includes(pathId)) continue;
				const keys = obj.objectIds
					.map((id) => this.ctx.store.document.objects[id])
					.filter((el): el is AnyArtObject => el !== undefined);
				if (keys.length < 2) continue;
				const spine = this.ctx.store.document.objects[obj.spineSourceId];
				if (!spine || !isPath(spine)) continue;
				// Move the spine's anchors onto the keys while keeping its cp1/cp2
				// handles so curves are preserved. Fall back to a straight polyline
				// only when the spine has fewer anchors than keys. blendKeyCenters are
				// WORLD coords, so bake the spine to world first and reset its
				// transform to identity — otherwise a spine with a non-identity
				// transform renders the reshaped segments offset by that transform.
				const centers = blendKeyCenters(keys, elementsMap);
				const worldSpine = toWorldPath(spine).segments;
				const segments =
					relocateSpineAnchorsToKeys(worldSpine, centers) ??
					polylineSpineSegments(centers);
				this.ctx.yjsProvider.updateElement(
					"",
					obj.spineSourceId,
					{
						segments,
						transform: createIdentityTransform(),
					} as Partial<AnyArtObject>,
					origin,
				);
			}
		}, origin);
	}

	public updateBlendSpacing(blendId: string, spacing: BlendSpacing): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.updateElement(layerId, blendId, { spacing } as Partial<BlendObject>);
	}

	public updateBlendEasing(
		blendId: string,
		key: "placementEasing" | "appearanceEasing",
		easing: BlendEasing,
	): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.updateElement(layerId, blendId, {
			[key]: easing,
		} as Partial<BlendObject>);
	}

	public updateBlendTilt(blendId: string, tiltToSpine: boolean): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.updateElement(layerId, blendId, {
			tiltToSpine,
		} as Partial<BlendObject>);
	}

	/**
	 * Replace a blend's spine with the given path. The path is absorbed (removed
	 * from the layer) and kept in document.objects as the editable spine source.
	 */
	public replaceBlendSpine(blendId: string, spineSourceId: string): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;

		const spineSource = this.ctx.store.document.objects[spineSourceId];
		if (!spineSource || !isPath(spineSource)) return;

		const keys = blend.objectIds
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is AnyArtObject => el !== undefined);

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.replaceBlendSpine(layerId, blendId, spineSourceId);
			// Reflow the keys onto the new spine (stored == drawn).
			this.reflowBlendKeysOntoSpine(keys, spineSource, origin);
		}, origin);
	}

	/** Reverse the order of a blend's source objects. */
	public reverseBlend(blendId: string): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;
		this.updateElement(layerId, blendId, {
			objectIds: [...blend.objectIds].reverse(),
		} as Partial<BlendObject>);
	}

	/**
	 * Release a blend: remove the blend and restore its source paths into the
	 * layer at the blend's position.
	 */
	public releaseBlend(blendId: string): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;

		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;

		this.ctx.yjsProvider.releaseBlend(blendId);
		this.ctx.store.selectedElementIds = blend.spineSourceId
			? [...blend.objectIds, blend.spineSourceId]
			: [...blend.objectIds];
	}

	// --- Repeat Operations ---

	/**
	 * Create a Repeat (Illustrator-style) from the current selection. Every
	 * selected element becomes a source, absorbed into the repeat (removed from
	 * the layer but kept in document.objects). Any element type may be a source.
	 * All sources must share one container. Returns the new repeat id, or null.
	 */
	public createRepeatFromSelection(mode: RepeatMode = "grid"): string | null {
		if (this.cannotMutate()) return null;

		const selectedSources = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is AnyArtObject => el !== undefined);

		if (selectedSources.length < 1) return null;

		// One shared parent container, same rule as blend: absorbing across
		// different layers/groups would be lossy and double-draw an unabsorbed
		// source.
		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedSources.map((s) => s.id),
		);
		if (!owner.ok) return null;

		const orderedSources = orderSourcesByContainer(
			this.ctx.store.document,
			owner.parentId,
			selectedSources,
		);

		const repeat = createRepeatObject(
			orderedSources.map((s) => s.id),
			{ mode },
		);

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.createRepeat(owner.parentId, repeat);
		}, origin);
		this.ctx.store.selectedElementIds = [repeat.id];
		return repeat.id;
	}

	// --- Mesh Warp Operations ---

	/**
	 * Create a mesh warp container from the current selection. Every selected
	 * element becomes a child, absorbed into the container (removed from the
	 * layer but kept in document.objects). The initial cage is one quad
	 * covering the children's combined bounds. Returns the new mesh id, or null.
	 */
	public createMeshWarpFromSelection(): string | null {
		if (this.cannotMutate()) return null;

		const selectedChildren = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is AnyArtObject => el !== undefined);

		if (selectedChildren.length < 1) return null;

		// One shared parent container, same rule as repeat/blend.
		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedChildren.map((s) => s.id),
		);
		if (!owner.ok) return null;

		const orderedChildren = orderSourcesByContainer(
			this.ctx.store.document,
			owner.parentId,
			selectedChildren,
		);

		const cage = this.meshContentBounds(orderedChildren.map((s) => s.id));
		if (!cage) return null;

		const mesh = createMeshWarpObject(
			orderedChildren.map((s) => s.id),
			cage,
		);

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.createMeshWarp(owner.parentId, mesh);
		}, origin);
		this.ctx.store.selectedElementIds = [mesh.id];
		return mesh.id;
	}

	/**
	 * Release a mesh warp container: remove it and restore its children —
	 * untouched, since the warp is non-destructive — into the container at the
	 * mesh's position.
	 */
	public releaseMeshWarp(meshId: string): void {
		if (this.cannotMutate() || this.isElementLocked(meshId)) return;
		const mesh = this.ctx.store.document.objects[meshId];
		if (!mesh || !isMesh(mesh)) return;
		const objects = this.ctx.store.document.objects;
		const elementsMap = new Map(Object.entries(objects));
		const outline = this.buildMeshOutlinePath(mesh, objects);
		this.ctx.yjsProvider.releaseMeshWarp(
			meshId,
			releasedChildTransforms(mesh, elementsMap),
			outline ?? undefined,
		);
		const ids = outline ? [outline.id, ...mesh.childIds] : [...mesh.childIds];
		if (this.ctx.selection) this.ctx.selection.selectMultiple(ids);
		else this.ctx.store.selectedElementIds = ids;
	}

	/**
	 * The cage's outer boundary as a path in the parent's space. Null for a
	 * mesh that did not come from a shape. The look comes straight from the
	 * tool settings: the active appearance would be read off the selection,
	 * which at this point is the mesh being released.
	 */
	private buildMeshOutlinePath(
		mesh: MeshArtObject,
		objects: Record<string, AnyArtObject>,
	): Path | null {
		if (!mesh.outlineOnRelease) return null;
		const world = getMeshWorldBoundarySegments(mesh, (id) => objects[id]);
		if (world.length === 0) return null;
		const segments: CubicBezierSegment[] = world.map((seg, i) => {
			const start = seg.start ?? world[i - 1].end;
			return {
				...(i === 0 ? { start: { x: start.x, y: start.y } } : {}),
				cp1: toRelativeCP1({ x: seg.cp1.x, y: seg.cp1.y }, start),
				cp2: toRelativeCP2({ x: seg.cp2.x, y: seg.cp2.y }, seg.end),
				end: { x: seg.end.x, y: seg.end.y },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: i === 0,
				...(i === world.length - 1 ? { isClosed: true } : {}),
			};
		});
		return {
			id: generateUid("path"),
			type: "path",
			segments,
			filters: [
				this.ctx.toolSettings?.strokeAppearance,
				this.ctx.toolSettings?.fillAppearance,
			]
				.filter((appearance) => appearance != null)
				.map((appearance) => cloneAppearance(appearance)),
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
	}

	/**
	 * Warp the selection into one of its members: the key object (or the first
	 * selected element) becomes the cage shape, the rest become the mesh
	 * content. The shape is replaced by the new mesh; an existing mesh warp
	 * used as the shape keeps its cage and releases its former content.
	 */
	public createMeshWarpFromShapeSelection(): MeshWarpFromShapeResult {
		if (this.cannotMutate()) return { ok: false, reason: "readonly" };
		const { store } = this.ctx;
		const selectedIds = store.selectedElementIds;
		const shapeId = store.keyObjectId ?? selectedIds[0];
		if (shapeId === undefined || !selectedIds.includes(shapeId)) {
			return { ok: false, reason: "invalid-selection" };
		}
		const objects = store.document.objects;
		const shape = objects[shapeId];
		const contents = selectedIds
			.filter((id) => id !== shapeId)
			.map((id) => objects[id]);
		if (!shape || contents.length === 0 || contents.some((c) => !c)) {
			return { ok: false, reason: "invalid-selection" };
		}
		if (selectedIds.some((id) => this.isElementLocked(id))) {
			return { ok: false, reason: "locked" };
		}
		const owner = resolveBlendSourceContainer(store.document, selectedIds);
		if (!owner.ok) return { ok: false, reason: "different-parent" };
		const parent = objects[owner.parentId];
		if (
			parent &&
			isGroup(parent) &&
			parent.clipPathId != null &&
			selectedIds.includes(parent.clipPathId)
		) {
			return { ok: false, reason: "invalid-selection" };
		}
		if (contents.some((c) => hasPassthroughDescendant(c, objects))) {
			return { ok: false, reason: "unsupported-content" };
		}
		const orderedIds = orderSourcesByContainer(
			store.document,
			owner.parentId,
			contents,
		).map((c) => c.id);

		const contentBounds = this.meshContentBounds(orderedIds);
		if (!contentBounds) return { ok: false, reason: "invalid-bounds" };

		let geometry = this.buildShapeWarpGeometry(shape, contentBounds);
		if (!geometry) return { ok: false, reason: "invalid-shape" };

		const elementsMap = new Map(Object.entries(objects));
		const shapeTransform = getTransform(shape);
		if (!isIdentityTransform(shapeTransform)) {
			geometry = mapWarpGeometryPositions(geometry, (p) =>
				applyTransformToPoint(p.x, p.y, shapeTransform),
			);
		}
		const mesh = createMeshWarpObjectFromGeometry(orderedIds, geometry);
		// A rectangle cage reused as the shape keeps releasing without a path.
		mesh.outlineOnRelease = isMesh(shape) ? shape.outlineOnRelease : true;

		const origin = this.getMutationOrigin();
		this.stopUndoCapture();
		const replaced = this.ctx.yjsProvider.replaceShapeWithMeshWarp(
			owner.parentId,
			shapeId,
			mesh,
			isMesh(shape)
				? releasedChildTransforms(shape, elementsMap)
				: new Map<string, ElementTransform>(),
			origin,
		);
		if (!replaced) return { ok: false, reason: "invalid-selection" };
		this.cleanupTextReferencesForDelete(new Set([shapeId]), origin);
		this.stopUndoCapture();

		if (this.ctx.selection) {
			this.ctx.selection.selectElement(mesh.id);
			this.ctx.selection.updateSelectionBounds();
		} else {
			store.selectedElementIds = [mesh.id];
			store.keyObjectId = null;
		}
		return { ok: true, meshId: mesh.id };
	}

	/**
	 * The union of the elements' bounds, at least one unit on each side: a
	 * zero-area source grid would make the warp parametrization degenerate.
	 */
	private meshContentBounds(ids: readonly string[]): BoundingBox | null {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const id of ids) {
			const bounds = this.ctx.spatial.getBounds(id);
			if (!bounds) return null;
			minX = Math.min(minX, bounds.minX);
			minY = Math.min(minY, bounds.minY);
			maxX = Math.max(maxX, bounds.maxX);
			maxY = Math.max(maxY, bounds.maxY);
		}
		if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
		if (maxX - minX < 1) maxX = minX + 1;
		if (maxY - minY < 1) maxY = minY + 1;
		return {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
		};
	}

	/** Cage geometry for a shape element, in the shape's own local space. */
	private buildShapeWarpGeometry(
		shape: AnyArtObject,
		contentBounds: BoundingBox,
	): WarpGeometry | null {
		if (isMesh(shape)) return remapWarpGeometrySrc(shape, contentBounds);
		if (!isPath(shape)) return null;
		const contour = resolveElementGeometry(
			shape.segments,
			localAppearances(shape.filters),
			{
				getHandler: (processor) => this.ctx.filterHandlerLookup?.(processor),
			},
		);
		const result = buildWarpGeometryFromContour(contour, contentBounds);
		return result.ok ? result.geometry : null;
	}

	/**
	 * Release a repeat: remove it and restore its source elements into the
	 * container at the repeat's position.
	 */
	public releaseRepeat(repeatId: string): void {
		if (this.cannotMutate() || this.isElementLocked(repeatId)) return;
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.ctx.yjsProvider.releaseRepeat(repeatId);
		this.ctx.store.selectedElementIds = [...repeat.sourceIds];
	}

	public setRepeatMode(repeatId: string, mode: RepeatMode): void {
		if (mode === "mirror") {
			// A "complete mirror": put the axis on the source's edge (half its width
			// from the center, along the default vertical axis) so the reflected copy
			// is flush against the original and the two read as one symmetric object.
			const repeat = this.ctx.store.document.objects[repeatId];
			if (repeat && isRepeat(repeat)) {
				const union = calculateRepeatSourceUnion(
					repeat,
					new Map(Object.entries(this.ctx.store.document.objects)),
				);
				const offset = union ? union.width / 2 : repeat.mirror.offset;
				this.updateRepeatFields(repeatId, {
					mode,
					mirror: roundNumericFields({ ...repeat.mirror, offset }),
				});
				return;
			}
		}
		this.updateRepeatFields(repeatId, { mode });
	}

	public updateRepeatGrid(
		repeatId: string,
		grid: Partial<RepeatGridParams>,
	): void {
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateRepeatFields(repeatId, {
			grid: roundNumericFields({ ...repeat.grid, ...grid }),
		});
	}

	public updateRepeatRadial(
		repeatId: string,
		radial: Partial<RepeatRadialParams>,
	): void {
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateRepeatFields(repeatId, {
			radial: roundNumericFields({ ...repeat.radial, ...radial }),
		});
	}

	public updateRepeatMirror(
		repeatId: string,
		mirror: Partial<RepeatMirrorParams>,
	): void {
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateRepeatFields(repeatId, {
			mirror: roundNumericFields({ ...repeat.mirror, ...mirror }),
		});
	}

	private updateRepeatFields(
		repeatId: string,
		fields: Partial<RepeatObject>,
	): void {
		if (this.cannotMutate() || this.isElementLocked(repeatId)) return;
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateElement("", repeatId, fields as Partial<AnyArtObject>);
	}

	// --- Clipping Path Operations ---

	/**
	 * Assign the group's clip path and strip that element's appearance: a clip
	 * path only contributes its shape, so its fills and strokes must not paint.
	 */
	private setClipPathForGroup(groupId: string, clipPathId: string): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.setClipPath(layerId, groupId, clipPathId);
			this.updateElement(layerId, clipPathId, { filters: [] });
		});
	}

	public createClipGroupFromTopmost(): string | null {
		if (this.cannotMutate()) return null;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return null;

		const selectedIds = this.ctx.store.selectedElementIds.filter(
			(id) => !this.isElementLocked(id),
		);
		if (selectedIds.length < 2) {
			console.warn("Need at least 2 elements to create clip group");
			return null;
		}

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);

		if (editingScopeId) {
			// Inside an editing scope: use the group's childIds for index lookup
			const parentGroup = this.ctx.store.document.objects[editingScopeId];
			if (!parentGroup || !isGroup(parentGroup)) return null;

			const selectedWithIndex = selectedIds
				.map((id) => {
					const index = parentGroup.childIds.indexOf(id);
					return { id, index };
				})
				.filter((item) => item.index !== -1);

			if (selectedWithIndex.length < 2) return null;

			selectedWithIndex.sort((a, b) => a.index - b.index);

			// Keep stacking order so the clip path ends up on top of the group.
			const orderedIds = selectedWithIndex.map((item) => item.id);
			const topmostId = orderedIds.at(-1)!;

			const groupId = this.ctx.yjsProvider.groupElementsInGroup(
				editingScopeId,
				orderedIds,
				this.getMutationOrigin(),
			);
			if (!groupId) return null;

			this.setClipPathForGroup(groupId, topmostId);
			this.ctx.store.selectedElementIds = [groupId];

			return groupId;
		}

		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return null;

		const selectedWithIndex = selectedIds
			.map((id) => {
				const index = layer.elementIds.indexOf(id);
				return { id, index };
			})
			.filter((item) => item.index !== -1);

		if (selectedWithIndex.length < 2) return null;

		selectedWithIndex.sort((a, b) => a.index - b.index);

		// Keep stacking order so the clip path ends up on top of the group.
		const orderedIds = selectedWithIndex.map((item) => item.id);
		const topmostId = orderedIds.at(-1)!;

		const groupId = this.ctx.yjsProvider.groupElements(
			layerId,
			orderedIds,
			this.getMutationOrigin(),
		);
		if (!groupId) return null;

		this.setClipPathForGroup(groupId, topmostId);
		this.ctx.store.selectedElementIds = [groupId];

		return groupId;
	}

	/**
	 * Convert a single element into a clip group: a new rectangle inherits the
	 * element's appearance and sits sized to its bounds, while the original
	 * element becomes the clip path that defines the visible shape. This
	 * decouples "what paints" from "what shape it's cut to".
	 */
	public convertToClipObject(elementId: string): string | null {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return null;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return null;

		const element = this.ctx.store.document.objects[elementId];
		if (!element) return null;

		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		const bounds = calculateElementBounds(element, elementsMap);
		if (bounds.width <= 0 || bounds.height <= 0) return null;

		const rect: Path = {
			type: "path",
			id: `path-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			transform: createIdentityTransform(),
			opacity: element.opacity,
			blendMode: element.blendMode,
			segments: generateRectangleSegments(
				{ x: bounds.minX, y: bounds.minY },
				{ x: bounds.maxX, y: bounds.maxY },
			),
			filters: deepClone(element.filters ?? []),
		};

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		let groupId: string | null = null;

		if (editingScopeId) {
			const parentGroup = this.ctx.store.document.objects[editingScopeId];
			if (!parentGroup || !isGroup(parentGroup)) return null;
			const index = parentGroup.childIds.indexOf(elementId);
			if (index === -1) return null;

			this.ctx.yjsProvider.transact(() => {
				this.ctx.yjsProvider.addObjectOnly(rect, this.getMutationOrigin());
				this.ctx.yjsProvider.addElementToGroup(
					layerId,
					editingScopeId,
					rect.id,
					this.getMutationOrigin(),
					index,
				);
				groupId = this.ctx.yjsProvider.groupElementsInGroup(
					editingScopeId,
					[rect.id, elementId],
					this.getMutationOrigin(),
				);
				if (groupId) this.setClipPathForGroup(groupId, elementId);
			}, this.getMutationOrigin());
		} else {
			const layer = this.ctx.store.document.layers.find(
				(l) => l.id === layerId,
			);
			if (!layer) return null;
			const index = layer.elementIds.indexOf(elementId);
			if (index === -1) return null;

			this.ctx.yjsProvider.transact(() => {
				this.ctx.yjsProvider.addElement(
					layerId,
					rect,
					this.getMutationOrigin(),
					index,
				);
				groupId = this.ctx.yjsProvider.groupElements(
					layerId,
					[rect.id, elementId],
					this.getMutationOrigin(),
				);
				if (groupId) this.setClipPathForGroup(groupId, elementId);
			}, this.getMutationOrigin());
		}

		if (groupId) this.ctx.store.selectedElementIds = [groupId];
		return groupId;
	}

	// --- Object Mask Operations ---

	/**
	 * Give an element an empty mask.
	 *
	 * Nothing disappears: the renderer skips a mask with no content, so an
	 * empty mask reads as "no mask yet" rather than "hide everything". Content
	 * is drawn into it through a mask-edit session.
	 *
	 * Does nothing when the element already has one.
	 */
	public addMaskToElement(elementId: string): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const element = this.ctx.store.document.objects[elementId];
		if (!element || element.mask) return;

		this.updateElementMask(elementId, { elementIds: [] });
	}

	/**
	 * Release an element's mask, promoting what was drawn into it.
	 *
	 * The content is not discarded: it lands beside the element it was masking,
	 * stacked directly above it in the same container. That also keeps it
	 * reachable — mask content belongs to no layer, so clearing the reference
	 * without rehoming it would strand the objects where nothing can select or
	 * delete them.
	 *
	 * Each root is re-parented from the element's local space into the
	 * container's, so it does not move: a shape that sat at the middle of the
	 * masked element is still at its middle afterwards.
	 */
	public removeMaskFromElement(elementId: string): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const document = this.ctx.store.document;
		const owner = document.objects[elementId];
		if (!owner?.mask) return;

		const containerId = findDirectContainerId(document, elementId);
		if (containerId == null) return;

		const roots = owner.mask.elementIds.filter((id) => document.objects[id]);
		const containerTransform =
			this.ctx.spatial.getAncestorTransform(elementId) ??
			createIdentityTransform();
		const ownerTransform = composeTransforms(
			containerTransform,
			getTransform(owner),
		);

		// Higher index renders later, so the roots go in just after the element
		// they were masking, keeping their own order among themselves.
		const siblingIds = containerChildIds(document, containerId);
		const insertAt = siblingIds.indexOf(elementId) + 1;
		const layer = document.layers.find((l) => l.id === containerId);
		const origin = this.getMutationOrigin();

		this.transact(() => {
			this.updateElementMask(elementId, null);

			roots.forEach((id, offset) => {
				const root = document.objects[id];
				if (!root) return;

				const promoted = {
					...root,
					transform: solveChildTransform(
						containerTransform,
						composeTransforms(ownerTransform, getTransform(root)),
					),
				};

				if (layer) {
					this.ctx.yjsProvider.addElement(
						layer.id,
						promoted,
						origin,
						insertAt + offset,
					);
					return;
				}
				this.ctx.yjsProvider.updateElement("", id, promoted, origin);
				// The object is already in the document and in no layer, so the
				// empty layer key leaves the group's childIds as the only edit.
				this.ctx.yjsProvider.addElementToGroup(
					"",
					containerId,
					id,
					origin,
					insertAt + offset,
				);
			});
		});
	}

	/** Turn an element's mask off without discarding what was drawn into it. */
	public setMaskEnabled(elementId: string, enabled: boolean): void {
		this.updateMaskFlag(elementId, { enabled });
	}

	/** Swap which side of the mask keeps the pixels. */
	public setMaskInverted(elementId: string, inverted: boolean): void {
		this.updateMaskFlag(elementId, { inverted });
	}

	private updateMaskFlag(
		elementId: string,
		patch: Partial<Pick<ObjectMask, "enabled" | "inverted">>,
	): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const mask = this.ctx.store.document.objects[elementId]?.mask;
		if (!mask) return;

		this.updateElementMask(elementId, { ...mask, ...patch });
	}

	/**
	 * Write a mask onto an element.
	 *
	 * The layer id is empty because a mask can be set on an element nested
	 * anywhere in the tree, and the update path does not consult it.
	 */
	private updateElementMask(elementId: string, mask: ObjectMask | null): void {
		this.updateElement("", elementId, { mask });
	}

	// --- Styling Operations ---

	public updateSelectedElementsStrokeColor(
		strokeColor: StrokeColor | null,
	): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const strokeIdx = filters.findIndex(
				(f) => !isAppearancePresetRef(f) && f.processor === "stroke",
			);

			if (strokeColor) {
				const strokeApp =
					strokeIdx >= 0 ? (filters[strokeIdx] as StrokeAppearance) : undefined;
				// Swapping the color must not reset everything else the user set
				// on this appearance. Reusing the uid also keeps the filter panel's
				// selection and the render caches keyed by it from resetting on
				// every color tweak.
				const newStroke: StrokeAppearance = {
					uid: strokeApp?.uid ?? generateUid("app"),
					processor: "stroke",
					opacity: strokeApp?.opacity ?? 1,
					blendMode: strokeApp?.blendMode ?? ("normal" as const),
					subFilters: strokeApp?.subFilters,
					paramData: {
						version: "1",
						params: {
							strokeColor,
							brushSettings: strokeApp?.paramData.params.brushSettings,
						},
					},
				};
				if (strokeIdx >= 0) {
					filters[strokeIdx] = newStroke;
				} else {
					filters.push(newStroke);
				}
			} else if (strokeIdx >= 0) {
				filters.splice(strokeIdx, 1);
			}

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	/** 選択中要素のfillを任意のFillColor（solid/linear/radial/free）で更新 */
	public updateSelectedElementsFill(fill: FillColor | null): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const fillIdx = filters.findIndex(
				(f) => !isAppearancePresetRef(f) && f.processor === "fill",
			);

			if (fill) {
				const fillApp =
					fillIdx >= 0 ? (filters[fillIdx] as FillAppearance) : undefined;
				// @see updateSelectedElementsStrokeColor for why the existing
				// appearance's own settings are carried over.
				const newFill: FillAppearance = {
					uid: fillApp?.uid ?? generateUid("app"),
					processor: "fill",
					opacity: fillApp?.opacity ?? 1,
					blendMode: fillApp?.blendMode ?? ("normal" as const),
					subFilters: fillApp?.subFilters,
					paramData: { version: "1", params: { fill } },
				};
				if (fillIdx >= 0) {
					filters[fillIdx] = newFill;
				} else {
					filters.push(newFill);
				}
			} else if (fillIdx >= 0) {
				filters.splice(fillIdx, 1);
			}

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	/**
	 * Delete the gradient stop / mesh vertex the gradient tool currently has
	 * selected (via toolSettings) from the selected element's fill.
	 * Linear/radial gradients keep at least two stops (an offset-based
	 * gradient needs both ends); free gradients keep at least one stop; mesh
	 * gradients keep their four corner vertices. Returns true when a stop was
	 * removed.
	 */
	public deleteSelectedGradientStop(): boolean {
		if (this.cannotMutate()) return false;

		const elementId = this.ctx.store.selectedElementIds[0];
		const element = elementId
			? this.ctx.store.document.objects[elementId]
			: null;
		const fillApp = getFirstFill(element?.filters);
		const fill = fillApp?.paramData.params.fill;
		if (!fill) return false;

		if (isLinearGradient(fill) || isRadialGradient(fill)) {
			const stopIndex = this.ctx.toolSettings?.gradientSelectedStopIndex;
			if (stopIndex == null || !fill.stops[stopIndex]) return false;
			if (fill.stops.length <= 2) return false;
			const updated = deepClone(fill);
			updated.stops = updated.stops.filter((_, i) => i !== stopIndex);
			this.updateSelectedElementsFill(updated);
			return true;
		}

		const stopId = this.ctx.toolSettings?.gradientSelectedStopId;
		if (stopId == null) return false;

		if (isMeshGradient(fill)) {
			if (!stopId.startsWith("mesh-vertex:")) return false;
			const vi = Number.parseInt(stopId.split(":")[1], 10);
			const vertex = fill.vertices[vi];
			if (Number.isNaN(vi) || vi < 4 || !vertex) return false;
			// A vertex the user colored in goes back to being derived rather than
			// away: it was part of the mesh before they gave it a color, and
			// removing it would leave the cut line it anchors half-attached.
			const demoted =
				vertex.colorMode === "explicit"
					? demoteMeshColorVertexToDerived<MeshGradientVertex>(
							fill.vertices,
							fill.faces,
							vi,
						)
					: null;
			if (demoted) {
				syncDerivedVertices(demoted, fill.faces);
				this.updateSelectedElementsFill({ ...fill, vertices: demoted });
				return true;
			}
			// Deleting a derived vertex deletes the whole split line it anchors;
			// deleteMeshVertex refuses anything that cannot go (corner-adjacent
			// by-products, lines through explicit vertices).
			const result = deleteMeshVertex<MeshGradientVertex>(
				fill.vertices,
				fill.faces,
				vi,
				4,
			);
			if (result.vertices.length === fill.vertices.length) return false;
			syncDerivedVertices(result.vertices, result.faces);
			this.updateSelectedElementsFill({
				...fill,
				vertices: result.vertices,
				faces: result.faces,
			});
			return true;
		}

		if (!isFreeGradient(fill)) return false;
		if (fill.stops.length <= 1) return false;

		const updated = deepClone(fill);
		updated.stops = updated.stops
			.filter((s) => s.id !== stopId)
			.map((s) => {
				if (!s.edgeCPs) return s;
				const { [stopId]: _, ...rest } = s.edgeCPs;
				return {
					...s,
					edgeCPs: Object.keys(rest).length > 0 ? rest : undefined,
				};
			});
		this.updateSelectedElementsFill(updated);
		return true;
	}

	public swapSelectedElementsColors(): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const strokeIdx = filters.findIndex(
				(f) => !isAppearancePresetRef(f) && f.processor === "stroke",
			);
			const fillIdx = filters.findIndex(
				(f) => !isAppearancePresetRef(f) && f.processor === "fill",
			);

			const strokeApp =
				strokeIdx >= 0 ? (filters[strokeIdx] as StrokeAppearance) : undefined;
			const fillApp =
				fillIdx >= 0 ? (filters[fillIdx] as FillAppearance) : undefined;

			const oldStrokeColor = strokeApp?.paramData.params.strokeColor ?? null;
			const oldFillColor = fillApp?.paramData.params.fill ?? null;

			// Stroke → Fill
			if (oldStrokeColor) {
				const newFillColor: FillColor =
					oldStrokeColor.type === "stroke-gradient"
						? oldStrokeColor.gradient
						: oldStrokeColor.type === "stroke-pattern"
							? oldStrokeColor.pattern
							: oldStrokeColor;
				const newFill: FillAppearance = {
					uid: fillApp?.uid ?? generateUid("app"),
					processor: "fill",
					opacity: fillApp?.opacity ?? 1,
					blendMode: fillApp?.blendMode ?? ("normal" as const),
					paramData: {
						version: "1",
						params: {
							fill: newFillColor,
						},
					},
				};
				if (fillIdx >= 0) {
					filters[fillIdx] = newFill;
				} else {
					filters.push(newFill);
				}
			} else if (fillIdx >= 0) {
				filters.splice(fillIdx, 1);
			}

			// Fill → Stroke (recalculate strokeIdx after possible splice)
			const newStrokeIdx = filters.findIndex(
				(f) => !isAppearancePresetRef(f) && f.processor === "stroke",
			);
			if (oldFillColor) {
				const newStrokeColor: StrokeColor =
					oldFillColor.type === "linear"
						? {
								type: "stroke-gradient",
								gradient: oldFillColor,
								mode: "within",
							}
						: oldFillColor.type === "solid"
							? oldFillColor
							: oldFillColor.type === "mesh"
								? oldFillColor.vertices.length > 0
									? { type: "solid", color: oldFillColor.vertices[0].color }
									: {
											type: "solid",
											color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
										}
								: oldFillColor.type === "pattern"
									? {
											type: "stroke-pattern",
											pattern: oldFillColor,
											mode: "within",
										}
									: oldFillColor.stops.length > 0
										? { type: "solid", color: oldFillColor.stops[0].color }
										: {
												type: "solid",
												color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
											};

				const newStroke: StrokeAppearance = {
					uid: strokeApp?.uid ?? generateUid("app"),
					processor: "stroke",
					opacity: strokeApp?.opacity ?? 1,
					blendMode: strokeApp?.blendMode ?? ("normal" as const),
					paramData: {
						version: "1",
						params: {
							strokeColor: newStrokeColor,
							brushSettings: strokeApp?.paramData.params.brushSettings,
						},
					},
				};
				if (newStrokeIdx >= 0) {
					filters[newStrokeIdx] = newStroke;
				} else {
					filters.push(newStroke);
				}
			} else if (newStrokeIdx >= 0) {
				filters.splice(newStrokeIdx, 1);
			}

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	public updateSelectedElementsFillColor(color: Color | null): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		this.updateSelectedElementsFill(color ? { type: "solid", color } : null);
	}

	public updateSelectedElementsBrushSettings(
		brushSettings: BrushSettings | undefined,
	): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const strokeIdx = filters.findIndex(
				(f) => !isAppearancePresetRef(f) && f.processor === "stroke",
			);
			if (strokeIdx < 0) continue;

			const strokeApp = filters[strokeIdx] as StrokeAppearance;
			if (
				areBrushSettingsSemanticallyEqual(
					strokeApp.paramData.params.brushSettings,
					brushSettings,
				)
			) {
				continue;
			}
			filters[strokeIdx] = {
				...strokeApp,
				paramData: {
					...strokeApp.paramData,
					params: { ...strokeApp.paramData.params, brushSettings },
				},
			};

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	/**
	 * Stack operations bound to the selected element's `filters`. Read it
	 * fresh per use: the selection may change between calls.
	 */
	public selectedElementFilterStack(): FilterStackCommands {
		return new FilterStackCommands(
			() => {
				if (this.cannotMutate()) return null;
				const element = this.getSelectedElement();
				if (
					!element ||
					!this.ctx.store.currentLayerId ||
					this.isElementLocked(element.id)
				)
					return null;
				return element.filters ?? [];
			},
			(filters) => {
				const element = this.getSelectedElement();
				const layerId = this.ctx.store.currentLayerId;
				if (!element || !layerId) return;
				this.updateElement(layerId, element.id, { filters });
			},
		);
	}

	/**
	 * Stack operations bound to a document appearance preset's `filters`.
	 * Presets hold no refs, so a ref written into one is dropped.
	 */
	public appearancePresetFilterStack(presetUid: string): FilterStackCommands {
		return new FilterStackCommands(
			() =>
				this.cannotMutate()
					? null
					: (this.getAppearancePreset(presetUid)?.filters ?? null),
			(filters) => {
				const preset = this.getAppearancePreset(presetUid);
				if (!preset) return;
				this.ctx.yjsProvider.setAppearancePreset(
					{ ...preset, filters: localAppearances(filters) },
					this.getMutationOrigin(),
				);
			},
		);
	}

	/** @see FilterStackCommands.updateStrokeBrushSettings */
	public updateSelectedElementStrokeBrushSettings(
		filterIndex: number,
		brushSettings: BrushSettings | undefined,
	): void {
		this.selectedElementFilterStack().updateStrokeBrushSettings(
			filterIndex,
			brushSettings,
		);
	}

	// --- Filter Operations (selected element) ---

	public addFilterToSelectedElement(filter: Filter): void {
		this.selectedElementFilterStack().addFilter(filter);
	}

	public removeFilterFromSelectedElement(filterIndex: number): void {
		this.selectedElementFilterStack().removeFilter(filterIndex);
	}

	/** @see FilterStackCommands.updateFilter */
	public updateFilterForSelectedElement(
		filterIndex: number,
		updates: Parameters<FilterStackCommands["updateFilter"]>[1],
	): void {
		this.selectedElementFilterStack().updateFilter(filterIndex, updates);
	}

	public reorderFilter(fromIndex: number, toIndex: number): void {
		this.selectedElementFilterStack().reorderFilter(fromIndex, toIndex);
	}

	// --- Artboard Operations ---

	public addArtboard(artboard: Artboard): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addArtboard(artboard);
	}

	public updateArtboard(id: string, updates: Partial<Artboard>): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.updateArtboard(id, updates);
	}

	public batchUpdateElements(
		elementUpdates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}>,
	): void {
		if (this.cannotMutate()) return;
		elementUpdates = elementUpdates.filter(
			(u) => !this.isElementLocked(u.elementId),
		);
		if (elementUpdates.length === 0) return;
		this.ctx.yjsProvider.batchUpdateElements(
			elementUpdates,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Rewrite elements' transforms so the fields act on each element as it is
	 * seen: a change of the rotation, scale or skew fields turns the element
	 * around the centre of its local bounds instead of its local origin, and
	 * a change of `x` and `y` moves it by that much. One undo step; locked
	 * elements are skipped.
	 */
	public updateElementTransforms(
		updates: Array<{ elementId: string; transform: ElementTransform }>,
	): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		this.transact(() => {
			for (const { elementId, transform } of updates) {
				const element = this.ctx.store.document.objects[elementId];
				const bounds = this.ctx.spatial.getLocalBounds(elementId);
				if (!element || !bounds) continue;
				const current = getTransform(element);
				const pivoted = keepPointInPlace(current, transform, {
					x: (bounds.minX + bounds.maxX) / 2,
					y: (bounds.minY + bounds.maxY) / 2,
				});
				this.updateElement(layerId, elementId, {
					transform: {
						...pivoted,
						x: pivoted.x + transform.x - current.x,
						y: pivoted.y + transform.y - current.y,
					},
				});
			}
		});
	}

	/**
	 * Rotate elements by angleDeg degrees around center (cx, cy).
	 *
	 * Each element's world placement is turned around (cx, cy) and solved
	 * back through its ancestors, so a mirrored, skewed or non-uniformly
	 * scaled ancestor turns it on screen the way the pointer turns. A group
	 * turns as a whole through its own transform, carrying its children along.
	 */
	public rotateElements(
		elementIds: string[],
		angleDeg: number,
		cx: number,
		cy: number,
	): void {
		if (this.cannotMutate()) return;

		const angleRad = (angleDeg * Math.PI) / 180;
		const cos = Math.cos(angleRad);
		const sin = Math.sin(angleRad);
		const rotation = { m00: cos, m01: -sin, m10: sin, m11: cos };
		const tx = cx - (cos * cx - sin * cy);
		const ty = cy - (sin * cx + cos * cy);

		const updates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];
		for (const elementId of this.filterOutGroupDescendants(elementIds)) {
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;
			updates.push({
				elementId,
				updates: {
					transform: applyWorldAffineToTransform(
						getTransform(element),
						this.ctx.spatial.getAncestorTransform(elementId),
						rotation,
						tx,
						ty,
					),
				} as Partial<AnyArtObject>,
			});
		}

		this.batchUpdateElements(updates);
	}

	/**
	 * Resize elements by mapping the selection frame's box onto `newBounds` in
	 * the frame's space. Each element bakes the map into its own space (see
	 * applyElementResize). Descendants of selected groups are left out, since
	 * their group carries the map down to them. A locked element is skipped;
	 * a locked element inside a resized container takes the map with it.
	 */
	public resizeElements(
		elementIds: string[],
		frame: SelectionFrame,
		newBounds: BoundingBox,
		flip: AxisFlip = { x: false, y: false },
	): void {
		if (this.cannotMutate()) return;

		const targetIds = this.filterOutGroupDescendants(elementIds);
		const inFrame = createResizeAffine(frame.bounds, newBounds, flip);
		// The map in the world: into the frame's space, resized, and back out.
		const inWorld = mapWithin(
			inFrame,
			invertAffine(elementTransformToAffine(frame.matrix)),
		);
		// Group resize fans out into one updateElement per descendant; a single
		// transaction keeps it to one Yjs→Valtio sync per commit instead of one
		// full-document sync per element.
		this.transact(() => {
			for (const id of targetIds) {
				const element = this.ctx.store.document.objects[id];
				if (!element || this.isElementLocked(id)) continue;
				// The frame's own element takes the resize as it is; any other
				// element takes it through its own world matrix.
				const world = this.ctx.spatial.getElementWorldMatrix(id);
				const map =
					frame.elementId === id || !world
						? inFrame
						: mapWithin(inWorld, elementTransformToAffine(world));
				this.applyElementResize(element, map);
			}
		});
	}

	/**
	 * Mirror elements in their selection frame's axes: the frame is mapped
	 * onto itself, turned over.
	 */
	public flipElements(elementIds: string[], flip: AxisFlip): void {
		const frame = resolveSelectionFrame(
			elementIds,
			(id) => this.ctx.spatial.getElementFrame(id),
			(id) => this.ctx.spatial.getWorldGeometryBounds(id),
		);
		if (frame) this.resizeElements(elementIds, frame, frame.bounds, flip);
	}

	/**
	 * Drop ids that are descendants of selected groups — group transforms
	 * recurse into children, so keeping both would double-apply the change.
	 */
	private filterOutGroupDescendants(elementIds: string[]): string[] {
		const descendantIds = new Set<string>();
		const collectDescendants = (groupId: string) => {
			const el = this.ctx.store.document.objects[groupId];
			if (el?.type !== "group") return;
			for (const childId of el.childIds) {
				descendantIds.add(childId);
				collectDescendants(childId);
			}
		};
		for (const id of elementIds) {
			collectDescendants(id);
		}
		return elementIds.filter((id) => !descendantIds.has(id));
	}

	/**
	 * Bake `map`, a resize expressed in the element's own space, into the
	 * element. A path takes it into its coordinates. A compound path, a blend
	 * and a group hand it down to their content, each child taking it in its
	 * own space. An image, a 3D reference and a text scale their rect by the
	 * map's axis factors and fold what is left, a mirror, a turn or a shear,
	 * into their transform. A mesh and a repeat fold it whole into theirs.
	 */
	private applyElementResize(element: AnyArtObject, map: Affine2D): void {
		const currentLayerId = this.ctx.store.currentLayerId;
		if (!currentLayerId) return;
		const update = (updates: Partial<AnyArtObject>) =>
			this.writeElement(currentLayerId, element.id, updates);
		const handDown = (childId: string) => {
			const child = this.ctx.store.document.objects[childId];
			if (!child) return;
			this.applyElementResize(
				child,
				mapWithin(map, elementTransformToAffine(getTransform(child))),
			);
		};

		const axisScale = resizeAxisScale(map);
		const det = map.a * map.d - map.b * map.c;
		// Sizes and widths follow the area of the map; a mirror rides the
		// transform or the geometry, never a negative size.
		const uniformScale = Math.sqrt(Math.abs(det));
		// A mirror turns a path's left into its right (see mirrorStrokeWidths).
		const flip: AxisFlip = { x: det < 0, y: false };
		// What the element's content takes of the map: a rect kind scales by
		// the axis factors and folds the rest into its transform, a mesh or
		// repeat folds it whole.
		const contentMap: Affine2D =
			element.type === "image" ||
			isReference3D(element) ||
			element.type === "text"
				? { a: axisScale.x, b: 0, c: 0, d: axisScale.y, e: 0, f: 0 }
				: isMesh(element) || isRepeat(element)
					? IDENTITY_AFFINE
					: map;
		const mappedSegments =
			element.type === "path" ? mapSegments(element.segments, map) : null;

		// Common properties that apply to all element types
		const commonUpdates: Record<string, unknown> = {};
		const scaleFilters = this.ctx.scaleFilters;
		const scaledFilters =
			element.filters?.length && scaleFilters
				? mapLocalAppearances(element.filters, (filters) =>
						scaleFilters(filters, axisScale.x, axisScale.y),
					)
				: undefined;
		// Stroke appearance widths for geometry-baking kinds (path, compound-path,
		// blend). Composed on top of the renderer-scaled filters so neither pass
		// overwrites the other.
		const strokeScaledFilters = scaleStrokeFilters(
			scaledFilters ?? element.filters,
			uniformScale,
		);
		// The gradients ride on the element's bounds, so they take the content
		// map in bounds-relative terms: out of the bounds they were placed in,
		// into the bounds the mapped content has.
		const boundsBefore =
			this.ctx.spatial.getLocalBounds(element.id) ??
			calculateLocalElementBounds(element);
		const boundsAfter =
			element.type === "path" && mappedSegments
				? calculateLocalElementBounds({
						...element,
						segments: mappedSegments,
						filters: strokeScaledFilters,
					})
				: transformBounds(boundsBefore, affineToElementTransform(contentMap));
		const gradientMap = boundsRelativeMap(
			contentMap,
			boundsBefore,
			boundsAfter,
		);
		const mapGradients = (filters: FilterEntry[]) =>
			isIdentityAffine(gradientMap)
				? filters
				: mapLocalAppearances(filters, (filters) =>
						mapGradientFilters(filters, gradientMap),
					);
		const rectFilters =
			scaledFilters ??
			(element.filters?.length && !isIdentityAffine(gradientMap)
				? element.filters
				: undefined);
		if (rectFilters) commonUpdates.filters = mapGradients(rectFilters);
		const geometryUpdates = {
			...commonUpdates,
			...(strokeScaledFilters
				? { filters: mapGradients(strokeScaledFilters) }
				: {}),
		};
		const remainder = () =>
			affineToElementTransform(resizeRemainder(map, axisScale));

		if (mappedSegments && element.type === "path") {
			update({
				segments: mappedSegments,
				...(element.strokeWidths && {
					strokeWidths: mirrorStrokeWidths(element.strokeWidths, flip),
				}),
				...(element.strokeErasure && {
					strokeErasure: mirrorStrokeWidths(element.strokeErasure, flip),
				}),
				...geometryUpdates,
			});
		} else if (element.type === "compound-path" || isBlend(element)) {
			// The sources take the map; the container keeps its own transform.
			for (const id of getContainerChildIds(element) ?? []) handDown(id);
			if (Object.keys(geometryUpdates).length > 0) update(geometryUpdates);
		} else if (element.type === "group") {
			for (const childId of element.childIds) handDown(childId);
		} else if (element.type === "image" || isReference3D(element)) {
			update({
				x: element.x * axisScale.x,
				y: element.y * axisScale.y,
				width: element.width * axisScale.x,
				height: element.height * axisScale.y,
				...(element.type === "image" &&
					element.corners && {
						corners: element.corners.map(([x, y]) => [
							x * axisScale.x,
							y * axisScale.y,
						]) as ImageObject["corners"],
					}),
				transform: composeTransforms(getTransform(element), remainder()),
				...commonUpdates,
			});
		} else if (element.type === "text") {
			// The anchor and the box scale away from the local origin like a
			// path's points do; the glyphs scale by the map's area.
			const local = calculateLocalElementBounds(element);
			update({
				x: element.x * axisScale.x,
				y: element.y * axisScale.y,
				layout: scaleTextLayout(element.layout, axisScale, {
					width: local.width * axisScale.x,
					height: local.height * axisScale.y,
				}),
				defaultStyle: scaleTextStyle(element.defaultStyle, uniformScale),
				content: scaleTextContent(element.content, uniformScale),
				transform: composeTransforms(getTransform(element), remainder()),
				...commonUpdates,
			});
			this.ctx.invalidateTextCache?.(element.id);
		} else if (isMesh(element) || isRepeat(element)) {
			// A mesh's warped children ride its transform entry, so the cage and
			// everything it bends scale together; a repeat scales both its tiles
			// and their spacing, unlike recursing into the absorbed sources.
			update({
				transform: composeTransforms(
					getTransform(element),
					affineToElementTransform(map),
				),
				...commonUpdates,
			} as Partial<AnyArtObject>);
		}
	}

	/**
	 * The own transform that draws an element's stored world geometry at those
	 * world coordinates. Under a transformed ancestor the renderer re-applies
	 * that ancestor transform on top of the stored geometry, so the element
	 * stores its inverse. `underIdentityChain` means the caller turns the
	 * ancestor chain into identity itself.
	 */
	private chainCancellingTransform(
		elementId: string,
		underIdentityChain = false,
	): ElementTransform {
		const ancestorT = underIdentityChain
			? null
			: this.ctx.spatial.getAncestorTransform(elementId);
		return ancestorT
			? computeInverseCompositionTransform(ancestorT)
			: createIdentityTransform();
	}

	/**
	 * World-space segments of a path plus the transform that keeps them in
	 * place (see chainCancellingTransform).
	 */
	private bakeWorldGeometry(path: Path): Pick<Path, "segments" | "transform"> {
		const worldPath = toWorldPath(
			path,
			this.ctx.spatial.getAncestorTransform(path.id) ?? undefined,
		);
		return {
			segments: worldPath.segments,
			transform: this.chainCancellingTransform(path.id),
		};
	}

	/**
	 * Move elements by a world delta in one undo step. A locked element is
	 * skipped. What a moved element carries along, a blend's sources or a
	 * text's axis path, follows it whatever its own lock says.
	 */
	public moveElements(
		elements: Array<{ layerId: string; elementId: string }>,
		deltaX: number,
		deltaY: number,
	): void {
		if (this.cannotMutate()) return;
		const updates = this.collectElementMoveUpdates(
			elements.filter(({ elementId }) => !this.isElementLocked(elementId)),
			deltaX,
			deltaY,
		);
		if (updates.length === 0) return;
		this.ctx.yjsProvider.batchUpdateElements(updates, this.getMutationOrigin());
	}

	/**
	 * Collect element move updates without committing to Yjs.
	 * Used by moveElements, commitArtboardMove, and align
	 * to batch all moves in a single Yjs transaction.
	 */
	public collectElementMoveUpdates(
		elements: Array<{ layerId: string; elementId: string }>,
		deltaX: number,
		deltaY: number,
	): Array<{ elementId: string; updates: Partial<AnyArtObject> }> {
		const result: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];
		const inputIds = new Set(elements.map((e) => e.elementId));
		const movedAxisPathIds = new Set<string>();
		// A stored translation lives in the parent's space, which the ancestor's
		// rotation/scale/skew map to world; undo that so the move is the world delta.
		const parentDelta = (id: string) => {
			const ancestorT = this.ctx.spatial.getAncestorTransform(id);
			return ancestorT
				? inverseTransformVector(deltaX, deltaY, ancestorT)
				: { x: deltaX, y: deltaY };
		};

		for (const { elementId } of elements) {
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			// Path-bound text: dragging the text moves the whole object — the
			// axis path is translated instead and the text follows through
			// re-layout (its glyph geometry derives from the path). Translating
			// both would double-move when path and text are selected together.
			if (element.type === "text" && element.axisBinding) {
				const pathId = element.axisBinding.pathObjectId;
				const path = this.ctx.store.document.objects[pathId];
				if (path?.type === "path") {
					if (!inputIds.has(pathId) && !movedAxisPathIds.has(pathId)) {
						movedAxisPathIds.add(pathId);
						const pt = getTransform(path);
						const d = parentDelta(pathId);
						result.push({
							elementId: pathId,
							updates: {
								transform: { ...pt, x: pt.x + d.x, y: pt.y + d.y },
							} as Partial<AnyArtObject>,
						});
					}
					continue;
				}
				// Dangling binding: fall through to a normal text move
			}

			const d = parentDelta(elementId);
			if (isBlend(element)) {
				const bt = getTransform(element);
				const isPureTranslate =
					bt.scaleX === 1 &&
					bt.scaleY === 1 &&
					(bt.rotation ?? 0) === 0 &&
					(bt.skewX ?? 0) === 0 &&
					(bt.skewY ?? 0) === 0;
				if (!isPureTranslate) {
					// Scaled/rotated blend: move its own transform. Baking a
					// non-translation matrix into the absorbed sources is out of
					// scope here.
					result.push({
						elementId,
						updates: {
							transform: { ...bt, x: bt.x + d.x, y: bt.y + d.y },
						} as Partial<AnyArtObject>,
					});
					continue;
				}
				// A blend's sources are absorbed and rendered (world-baked) under the
				// blend's transform index, so they have no transform slot of their
				// own. Keeping the translation on the blend desyncs the stored source
				// positions from what is drawn (breaking gradient-edit UI and release
				// placement). Bake any existing blend translation + this move into the
				// sources (and spine) and reset the blend to identity, so stored ==
				// displayed everywhere.
				const srcIds = element.spineSourceId
					? [...element.objectIds, element.spineSourceId]
					: element.objectIds;
				for (const srcId of srcIds) {
					const src = this.ctx.store.document.objects[srcId];
					if (!src) continue;
					const st = getTransform(src);
					result.push({
						elementId: srcId,
						updates: {
							transform: {
								...st,
								x: st.x + bt.x + d.x,
								y: st.y + bt.y + d.y,
							},
						} as Partial<AnyArtObject>,
					});
				}
				if (bt.x !== 0 || bt.y !== 0) {
					// The spine source is baked alongside the other sources above;
					// only the blend's own transform needs resetting to identity.
					result.push({
						elementId,
						updates: {
							transform: createIdentityTransform(),
						} as Partial<AnyArtObject>,
					});
				}
				continue;
			}

			const t = getTransform(element);
			result.push({
				elementId,
				updates: {
					transform: { ...t, x: t.x + d.x, y: t.y + d.y },
				} as Partial<AnyArtObject>,
			});
		}

		return result;
	}

	/**
	 * Align the current multi-selection along `mode`, using the key object (or
	 * the selection union) as the reference. Returns true when anything moved.
	 */
	public alignSelectedElements(mode: AlignMode): boolean {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return false;

		const items = this.collectAlignItems(this.ctx.store.selectedElementIds);
		if (items.length < 2) return false;

		const keyObjectId = this.ctx.store.keyObjectId;
		const keyItem =
			keyObjectId != null
				? items.find((it) => it.id === keyObjectId)
				: undefined;
		const reference = keyItem?.bounds ?? unionBounds(items);
		if (!reference) return false;

		return this.applyAlignDeltas(
			layerId,
			computeAlignDeltas(items, mode, reference),
		);
	}

	/**
	 * Distribute the current multi-selection so element centers are evenly
	 * spaced along `axis`. The two extreme elements stay put. Needs at least 3
	 * selected elements. Returns true when anything moved.
	 */
	public distributeSelectedElements(axis: DistributeAxis): boolean {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return false;

		const items = this.collectAlignItems(this.ctx.store.selectedElementIds);
		if (items.length < 3) return false;

		return this.applyAlignDeltas(layerId, computeDistributeDeltas(items, axis));
	}

	private collectAlignItems(elementIds: readonly string[]): AlignItem[] {
		const items: AlignItem[] = [];
		for (const id of elementIds) {
			const bounds = this.ctx.spatial.getWorldBounds(id);
			if (bounds) items.push({ id, bounds });
		}
		return items;
	}

	private applyAlignDeltas(
		layerId: string,
		deltas: Map<string, AlignDelta>,
	): boolean {
		if (this.cannotMutate()) return false;

		const updates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];
		for (const [elementId, { dx, dy }] of deltas) {
			if ((dx === 0 && dy === 0) || this.isElementLocked(elementId)) continue;
			// Reuse the shared move-update builder so blend baking and axis-path
			// following stay correct, applied per element with its own delta.
			updates.push(
				...this.collectElementMoveUpdates([{ layerId, elementId }], dx, dy),
			);
		}
		if (updates.length === 0) return false;

		// Written past the per-element lock check: what an aligned element
		// carries along moves with it (see moveElements).
		this.ctx.yjsProvider.batchUpdateElements(updates, this.getMutationOrigin());

		for (const id of deltas.keys()) {
			this.ctx.spatial.invalidateBounds(id);
			this.rebuildBlendSpineIfKey(id);
		}
		return true;
	}

	/**
	 * Compute per-element updates that destructively bake a perspective warp —
	 * the homography mapping the four `sourceCorners` onto the four dragged
	 * `corners` (both TL, TR, BR, BL in world space) — into element geometry
	 * (vertex editing, mirroring MeshDeformTool's commit): paths get their
	 * segments re-projected with adaptive subdivision and the stored transform
	 * re-resolved; images get warped corner vertices; meshes get warped
	 * vertices. Groups expand to leaves and compound paths to their source
	 * paths. Text is skipped — the tool outlines it into paths first. A locked
	 * element in `elementIds` is left out; the content of an unlocked one is
	 * warped whatever its own lock says. Returned WITHOUT committing so a tool
	 * can preview then commit on release.
	 */
	public computePerspectiveWarpUpdates(
		elementIds: string[],
		corners: [Vec2, Vec2, Vec2, Vec2],
		sourceCorners: [Vec2, Vec2, Vec2, Vec2],
	): Array<{ elementId: string; updates: Partial<AnyArtObject> }> {
		if (this.cannotMutate()) return [];

		const toPoints = (quad: [Vec2, Vec2, Vec2, Vec2]) =>
			quad.map(([x, y]) => ({ x, y })) as [Point, Point, Point, Point];
		const H = solveHomography(toPoints(sourceCorners), toPoints(corners));
		if (!H) return [];

		// Stroke widths follow the warp's overall size change: the square root
		// of the quad area ratio, so a pure shear (area-preserving) keeps widths.
		const sourceArea = quadArea(sourceCorners);
		const strokeScale =
			sourceArea > 0 ? Math.sqrt(quadArea(corners) / sourceArea) : 1;
		const worldDeform = (x: number, y: number) => projectViaH(x, y, H);

		const getElement = (id: string): AnyArtObject | null =>
			this.ctx.store.document.objects[id] ?? null;

		// Expand groups to leaves, then compound paths to their source paths.
		const leafIds: string[] = [];
		for (const id of flattenElementIds(
			elementIds.filter((id) => !this.isElementLocked(id)),
			getElement,
		)) {
			const el = getElement(id);
			if (el && isCompoundPath(el)) {
				for (const { id: sourceId } of el.sources) leafIds.push(sourceId);
			} else {
				leafIds.push(id);
			}
		}

		const updates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];

		for (const elementId of leafIds) {
			const element = getElement(elementId);
			if (!element) continue;
			if (!isDeformableElement(element) || element.type === "text") continue;

			const ancestorTransform =
				this.ctx.spatial.getAncestorTransform(elementId);
			const frame: DeformFrame = {
				ancestorTransform,
				composedTransform: ancestorTransform
					? composeTransforms(ancestorTransform, element.transform)
					: element.transform,
				// For images the deform frame is the x/y/width/height rectangle,
				// not the corners' AABB.
				localBounds:
					element.type === "image"
						? brandLocalBBox({
								minX: element.x - element.width / 2,
								minY: element.y - element.height / 2,
								maxX: element.x + element.width / 2,
								maxY: element.y + element.height / 2,
								width: element.width,
								height: element.height,
							})
						: calculateLocalElementBounds(element),
			};
			const deformPoint = createLocalPointDeformer(frame, worldDeform);

			if (element.type === "path") {
				// Project through the homography with control-point re-fitting:
				// straight edges bend smoothly under perspective while the anchor
				// count stays put (a rectangle bakes as its original 4 segments) —
				// splits happen only when a single cubic cannot hold the tolerance.
				const segments = fitSegmentsWithProjection(
					element.segments,
					(x, y) => deformPoint({ x, y }),
					projectionErrorThreshold(frame.localBounds),
				);
				const newLocalBounds = calculateLocalElementBounds({
					...element,
					segments,
				});
				const filters = scaleStrokeFilters(
					deformGradientFilters(
						element,
						deformPoint,
						frame.localBounds,
						newLocalBounds,
						{ x: 0, y: 0 },
					) ?? element.filters,
					strokeScale,
				);
				updates.push({
					elementId,
					updates: {
						segments,
						...(filters ? { filters } : {}),
					} as Partial<AnyArtObject>,
				});
			} else if (element.type === "image") {
				// Bake into the corner vertices: warp the current effective corners
				// (re-warping composes on the previous corners, no filter stacking).
				const current: Array<{ x: number; y: number }> =
					element.corners?.map(([x, y]) => ({ x, y })) ??
					cornersFromBounds(frame.localBounds);
				const newCorners = current.map((p) => {
					const d = deformPoint(p);
					return [d.x, d.y];
				}) as [Vec2, Vec2, Vec2, Vec2];
				updates.push({
					elementId,
					updates: { corners: newCorners } as Partial<AnyArtObject>,
				});
			} else if (element.type === "mesh") {
				// Warp cage vertices + handles only; `src` must stay untouched so
				// the source parametrization (and therefore the children's warp)
				// follows the moved cage.
				const { vertices } = mapWarpGeometryPositions(element, deformPoint);
				const newLocalBounds = brandLocalBBox(
					calculateMeshCoordinateBounds(vertices),
				);
				const filters = deformGradientFilters(
					element,
					deformPoint,
					frame.localBounds,
					newLocalBounds,
					{ x: 0, y: 0 },
				);
				updates.push({
					elementId,
					updates: {
						vertices,
						...(filters ? { filters } : {}),
					} as Partial<AnyArtObject>,
				});
			}
		}

		return updates;
	}

	public commitArtboardMove(
		artboardId: string,
		artboardUpdates: Partial<Artboard>,
		elementMoves: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}>,
	): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.commitArtboardMove(
			artboardId,
			artboardUpdates,
			elementMoves,
		);
	}

	public deleteArtboard(id: string): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.deleteArtboard(id);

		if (this.ctx.store.selectedArtboardId === id) {
			this.ctx.store.selectedArtboardId = null;
			setArtboardSelectionOverlay(this.ctx.store.uiOverlayState, null);
		}
	}

	// --- Document Settings ---

	public setHdr(hdr: Partial<HdrSettings>): void {
		if (this.cannotMutate()) return;
		const current = this.ctx.store.document.hdr ?? {
			enabled: false,
			exposure: 0,
		};
		this.ctx.yjsProvider.setHdr({ ...current, ...hdr });
	}

	public setColorProfile(colorProfile: Partial<ColorProfileSettings>): void {
		if (this.cannotMutate()) return;
		const current: ColorProfileSettings = this.ctx.store.document
			.colorProfile ?? { workingSpace: "display-p3" };
		this.ctx.yjsProvider.setColorProfile({ ...current, ...colorProfile });
	}

	public setRasterizationDpi(dpi: number): void {
		if (this.cannotMutate()) return;
		if (!Number.isFinite(dpi) || dpi <= 0) return;
		this.ctx.yjsProvider.setRasterizationDpi(dpi);
	}

	public setUnits(units: LengthUnit): void {
		if (this.cannotMutate()) return;
		if (!isLengthUnit(units)) return;
		this.ctx.yjsProvider.setUnits(units);
	}

	// --- Defs (off-canvas ArtObject definitions) ---
	//
	// Thin wrappers over YjsProvider's def CRUD. Member element CRUD continues
	// to go through addObjectOnly / updateElement / deleteElements — defs only
	// own the rootElementIds list and the def metadata.

	public createDef(entry: DefEntry): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.createDef(entry, this.getMutationOrigin());
	}

	public deleteDef(defId: string): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.deleteDef(defId, this.getMutationOrigin());
	}

	public updateDefMeta(
		defId: string,
		patch: Partial<Pick<DefEntry, "name" | "tile" | "kind">>,
	): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.updateDefMeta(defId, patch, this.getMutationOrigin());
	}

	public replaceDefElements(defId: string, newRootElementIds: string[]): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.replaceDefElements(
			defId,
			newRootElementIds,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Snapshot the current selection as a fresh pattern def and return the new
	 * def id. The resulting DefEntry carries a tile sized to the selection
	 * bbox. See `snapshotSelectionAsDef` for the shared cloning semantics.
	 */
	public createPatternDefFromSelection(name?: string): string | null {
		return this.snapshotSelectionAsDef("pattern", name);
	}

	/**
	 * Snapshot the current selection as a fresh vector-brush def and return
	 * the new def id. Unlike pattern defs, no tile rectangle is recorded —
	 * the brush rasterizer samples the tight bbox of the def's root elements.
	 * See `snapshotSelectionAsDef` for the shared cloning semantics.
	 */
	public createVectorBrushDefFromSelection(name?: string): string | null {
		return this.snapshotSelectionAsDef("vector-brush", name);
	}

	/**
	 * Shared body for `create*DefFromSelection`. The selected (top-level)
	 * elements + their descendants are deeply cloned with re-minted ids,
	 * translated so the selection bbox is centered on the def-local origin,
	 * added to `document.objects` (without a layer reference, mirroring
	 * `BlendObject.spineSourceId`), and finally a new DefEntry of the given
	 * kind is created with the cloned root ids. A tile sized to the selection
	 * bbox is recorded only for `"pattern"` defs.
	 *
	 * Returns null when the selection is empty, contains only unresolvable
	 * ids, or the bbox has zero area.
	 */
	private snapshotSelectionAsDef(kind: DefKind, name?: string): string | null {
		if (this.cannotMutate()) return null;
		const selectedIds = this.ctx.store.selectedElementIds;
		if (selectedIds.length === 0) return null;
		const objects = this.ctx.store.document.objects;
		const topLevel: AnyArtObject[] = [];
		for (const id of selectedIds) {
			const obj = objects[id];
			if (obj) topLevel.push(obj);
		}
		if (topLevel.length === 0) return null;

		// Collect descendants reachable through container references so the
		// def clone is self-contained. Pulled inline here (rather than reusing
		// pasteElements' helper) to keep the snapshot atomic.
		const allIds = new Set<string>();
		const stack: string[] = topLevel.map((e) => e.id);
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (allIds.has(id)) continue;
			allIds.add(id);
			const obj = objects[id];
			if (!obj) continue;
			if (obj.mask) for (const mid of obj.mask.elementIds) stack.push(mid);
			switch (obj.type) {
				case "group":
					for (const cid of obj.childIds) stack.push(cid);
					if (obj.clipPathId) stack.push(obj.clipPathId);
					break;
				case "blend":
					for (const cid of obj.objectIds) stack.push(cid);
					if (obj.spineSourceId) stack.push(obj.spineSourceId);
					break;
				case "repeat":
					for (const cid of obj.sourceIds) stack.push(cid);
					break;
				case "compound-path":
					for (const s of obj.sources) stack.push(s.id);
					break;
				case "mesh":
					for (const cid of obj.childIds) stack.push(cid);
					break;
				case "text":
					if (obj.axisBinding) stack.push(obj.axisBinding.pathObjectId);
					if (obj.clipPathId) stack.push(obj.clipPathId);
					break;
				case "path":
				case "image":
				case "reference3d":
					// Reference no other elements beyond the mask handled above.
					break;
				default:
					neverReached(obj, "unhandled element type in def snapshot walk");
			}
		}
		const sourceElements: AnyArtObject[] = [];
		for (const id of allIds) {
			const obj = objects[id];
			if (obj) sourceElements.push(obj);
		}

		// Compute the world-space bbox of the top-level selection. Descendants
		// transform through their parents so we only need the visible top-level
		// bounds for the tile rectangle.
		const elementsMap = new Map(sourceElements.map((e) => [e.id, e]));
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const el of topLevel) {
			const b = calculateElementBounds(el, elementsMap);
			if (b.minX < minX) minX = b.minX;
			if (b.minY < minY) minY = b.minY;
			if (b.maxX > maxX) maxX = b.maxX;
			if (b.maxY > maxY) maxY = b.maxY;
		}
		if (
			!Number.isFinite(minX) ||
			!Number.isFinite(maxX) ||
			maxX - minX <= 0 ||
			maxY - minY <= 0
		) {
			return null;
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const tileWidth = maxX - minX;
		const tileHeight = maxY - minY;

		// Clone + remap. Only translate the top-level elements so children
		// (whose coordinates are relative to their parents) stay intact.
		const { cloned, idMap } = cloneElementsWithIdRemap(sourceElements);
		const topLevelOldIds = new Set(topLevel.map((e) => e.id));
		for (const c of cloned) {
			const isTopLevel = [...idMap.entries()].some(
				([oldId, newId]) => newId === c.id && topLevelOldIds.has(oldId),
			);
			if (!isTopLevel) continue;
			c.transform = {
				...c.transform,
				x: c.transform.x - cx,
				y: c.transform.y - cy,
			};
		}

		const rootElementIds = topLevel
			.map((e) => idMap.get(e.id))
			.filter((id): id is string => typeof id === "string");

		const defId = generateUid("def");
		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const c of cloned) {
				this.ctx.yjsProvider.addObjectOnly(c, origin);
			}
			const entry: DefEntry = {
				id: defId,
				kind,
				name,
				rootElementIds,
			};
			if (kind === "pattern") {
				entry.tile = { width: tileWidth, height: tileHeight };
			}
			this.ctx.yjsProvider.createDef(entry, origin);
		}, origin);

		return defId;
	}

	// --- File Operations ---

	public addEmbeddedFile(file: EmbeddedFile): string {
		if (this.cannotMutate()) return "";
		return this.ctx.yjsProvider.addFile(file);
	}

	// --- Brush Preset Operations ---

	public addBrushPreset(preset: BrushPreset): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addBrushPreset(preset);
	}

	// --- Appearance Preset Operations ---

	/**
	 * Capture the element's resolved appearance as a new document preset and
	 * make the element reference it. Returns the preset uid, or null when the
	 * element has no appearance to capture.
	 */
	public createAppearancePresetFromElement(
		elementId: string,
		name: string,
	): string | null {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return null;
		const element = this.ctx.store.document.objects[elementId];
		if (!element) return null;

		const captured = captureAppearancePreset(
			element,
			name,
			createAppearancePresetsMap(this.ctx.store.document),
		);
		if (!captured) return null;

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.setAppearancePreset(captured.preset, origin);
			this.ctx.yjsProvider.batchUpdateElements(
				[{ elementId, updates: { filters: captured.filters } }],
				origin,
			);
		}, origin);
		return captured.preset.uid;
	}

	/** Insert a ref to the preset into each selected element's stack (at the end when `index` is omitted). */
	public insertAppearancePresetRefToSelectedElements(
		presetUid: string,
		index?: number,
	): void {
		if (this.cannotMutate() || !this.getAppearancePreset(presetUid)) return;

		const updates = this.ctx.store.selectedElementIds.flatMap((elementId) => {
			const element = this.ctx.store.document.objects[elementId];
			if (!element || this.isElementLocked(elementId)) return [];
			const filters = [...(element.filters ?? [])];
			const ref: AppearancePresetRef = {
				type: "preset",
				uid: generateUid("app"),
				presetUid,
			};
			filters.splice(index ?? filters.length, 0, ref);
			return [{ elementId, updates: { filters } }];
		});
		if (updates.length === 0) return;
		this.ctx.yjsProvider.batchUpdateElements(updates, this.getMutationOrigin());
	}

	/** Replace the preset ref at `entryIndex` with copies of the preset's filters. */
	public expandAppearancePresetRef(
		elementId: string,
		entryIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const element = this.ctx.store.document.objects[elementId];
		const entry = element?.filters?.[entryIndex];
		if (!element || !entry || !isAppearancePresetRef(entry)) return;
		const preset = this.getAppearancePreset(entry.presetUid);
		if (!preset) return;

		const filters = [...element.filters!];
		filters.splice(entryIndex, 1, ...expandAppearancePresetRef(entry, preset));
		this.ctx.yjsProvider.batchUpdateElements(
			[{ elementId, updates: { filters } }],
			this.getMutationOrigin(),
		);
	}

	/** Put a preset back to an earlier state, e.g. when an edit is abandoned. */
	public restoreAppearancePreset(preset: AppearancePreset): void {
		if (this.cannotMutate() || !this.getAppearancePreset(preset.uid)) return;
		this.ctx.yjsProvider.setAppearancePreset(preset, this.getMutationOrigin());
	}

	public renameAppearancePreset(presetUid: string, name: string): void {
		if (this.cannotMutate()) return;
		const preset = this.getAppearancePreset(presetUid);
		if (!preset || preset.name === name) return;
		this.ctx.yjsProvider.setAppearancePreset(
			{ ...preset, name },
			this.getMutationOrigin(),
		);
	}

	/**
	 * Add a preset (library / JSON import). A preset the document already has
	 * under the same uid is reused as-is, so repeated imports do not pile up.
	 * Returns the document uid.
	 */
	public addAppearancePreset(preset: AppearancePreset): string | null {
		if (this.cannotMutate()) return null;
		if (this.getAppearancePreset(preset.uid)) return preset.uid;
		this.ctx.yjsProvider.setAppearancePreset(preset, this.getMutationOrigin());
		return preset.uid;
	}

	/** Delete a preset after expanding every ref to it, so referencing elements keep their look. */
	public deleteAppearancePreset(presetUid: string): void {
		if (this.cannotMutate()) return;
		const preset = this.getAppearancePreset(presetUid);
		if (!preset) return;

		const updates = Object.values(this.ctx.store.document.objects).flatMap(
			(element) => {
				const filters = expandAppearancePresetRefs(element.filters, preset);
				if (!filters || this.isElementLocked(element.id)) return [];
				return [{ elementId: element.id, updates: { filters } }];
			},
		);
		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			if (updates.length > 0) {
				this.ctx.yjsProvider.batchUpdateElements(updates, origin);
			}
			this.ctx.yjsProvider.deleteAppearancePreset(presetUid, origin);
		}, origin);
	}

	private getAppearancePreset(presetUid: string): AppearancePreset | null {
		return (
			this.ctx.store.document.appearancePresets?.find(
				(p) => p.uid === presetUid,
			) ?? null
		);
	}

	/**
	 * Ensure built-in brush files exist in the document.
	 * Called during project initialization.
	 */
	public async ensureBuiltinBrushes(): Promise<void> {
		if (this.cannotMutate()) return;
		const builtinTextureIds = [
			...Object.values(BUILTIN_BRUSH_IDS).filter(
				(id) => id !== BUILTIN_BRUSH_IDS.svg,
			),
			...Object.values(BUILTIN_PAPER_IDS),
		];
		const hasAllFiles = builtinTextureIds.every((id) =>
			this.ctx.store.document.files.some((file) => file.uid === id),
		);

		if (hasAllFiles) return;

		const files = await createBuiltinBrushFiles();
		for (const file of files) {
			this.ctx.yjsProvider.addFile(file);
		}
	}

	// --- Clipboard Operations ---

	/**
	 * Copy selected elements to system clipboard (PNG + PAPLICO_ELEMENTS_MIME).
	 */
	public async copySelectedToClipboard(): Promise<void> {
		const { elementIds, artObjects } = this.collectSelectedElements();
		if (elementIds.length === 0) return;
		await this.writeToSystemClipboard(elementIds, artObjects);
	}

	/**
	 * Cut selected elements: copy to system clipboard then delete.
	 * Axis paths bound only by cut texts go with them (they are invisible
	 * guides; the clipboard payload carries them for self-contained paste).
	 * Cutting a flow chain's trailing members takes their flowed-in text
	 * along (see materializeFlowCut).
	 */
	public async cutSelectedToClipboard(): Promise<void> {
		if (this.cannotMutate()) return;
		const { elementIds, artObjects } = this.collectSelectedElements();
		if (elementIds.length === 0) return;
		const truncations = await this.materializeFlowCut(elementIds, artObjects);
		await this.writeToSystemClipboard(elementIds, artObjects);
		// Use the ids captured before the clipboard await — the live selection
		// could change during it
		for (const { headId, content } of truncations) {
			this.ctx.yjsProvider.updateElement(
				"",
				headId,
				{ content } as Partial<AnyArtObject>,
				this.getMutationOrigin(),
			);
		}
		this.deleteElements([
			...elementIds,
			...this.collectExclusiveAxisPathIds(new Set(elementIds)),
		]);
	}

	/**
	 * Flow-aware cut: when a chain's trailing members are cut, the text that
	 * flowed into them leaves with them — the head's content is truncated at
	 * the first cut member's flowed range and the removed portion is
	 * materialized into that member's clipboard clone (with the head's
	 * defaultStyle), so pasting it reproduces the visible text. Cutting only
	 * middle members changes nothing here: content stays on the head and
	 * deletion splices the flow to the next surviving region.
	 */
	private async materializeFlowCut(
		cutIds: string[],
		clones: AnyArtObject[],
	): Promise<Array<{ headId: string; content: TextContent }>> {
		const textRenderer = this.ctx.getTextRenderer?.();
		if (!textRenderer) return [];
		const objects = this.ctx.store.document.objects;
		const cutSet = new Set(cutIds);
		const handledHeads = new Set<string>();
		const truncations: Array<{ headId: string; content: TextContent }> = [];

		for (const id of cutIds) {
			const obj = objects[id];
			if (obj?.type !== "text") continue;
			const chain = textRenderer.getFlowChainMembers(obj);
			if (!chain || chain.length <= 1) continue;
			const headId = chain[0].id;
			// A cut head is handled by the existing head-promotion rules
			if (cutSet.has(headId) || handledHeads.has(headId)) continue;

			// Earliest member whose entire downstream suffix is being cut
			let trailingStart = -1;
			for (let i = chain.length - 1; i >= 1; i--) {
				if (!cutSet.has(chain[i].id)) break;
				trailingStart = i;
			}
			if (trailingStart === -1) continue;
			handledHeads.add(headId);

			const member = chain[trailingStart];
			const start = await textRenderer.getFlowedRangeStart(member);
			if (start === null) continue;
			const head = objects[headId];
			if (head?.type !== "text") continue;

			const { before, after } = splitTextContentAt(head.content, start);
			const clone = clones.find((c) => c.id === member.id);
			if (clone?.type === "text") {
				clone.content = after;
				clone.defaultStyle = { ...head.defaultStyle };
			}
			truncations.push({ headId, content: before });
		}
		return truncations;
	}

	/**
	 * Duplicate selected elements in place with a small offset.
	 * Returns IDs of the newly created elements.
	 */
	public duplicateElements(): string[] {
		const { artObjects } = this.collectSelectedElements();
		if (artObjects.length === 0) return [];
		return this.pasteElements(artObjects);
	}

	/**
	 * Duplicate the given elements (and their absorbed container children) with a
	 * direct offset, stacked right in front of the frontmost source. Shared by
	 * the alt-drag gesture (via ToolContext) so it goes through the same clone /
	 * id-numbering / container-remap path as copy-paste.
	 */
	public duplicateElementsByIds(
		elementIds: string[],
		offset: { x: number; y: number } = { x: 0, y: 0 },
	): string[] {
		const { artObjects } = this.collectElementsByIds(elementIds);
		if (artObjects.length === 0) return [];
		return this.pasteElements(artObjects, {
			offset,
			placement: "front",
			placementAnchorIds: elementIds,
		});
	}

	/**
	 * Read system clipboard and paste whichever supported format is found.
	 * Priority: PAPLICO elements → SVG → raster image → plain text.
	 */
	public async pasteFromSystemClipboard(opt?: {
		viewport?: { x: number; y: number };
		placement?: "front" | "back";
	}): Promise<string[]> {
		try {
			const viewport = opt?.viewport;

			const items = await Clipboard.read();
			// 1. PAPLICO elements (highest priority)
			const elements = await readClipboardElements(items);
			if (elements) return this.pasteElements(elements, opt);

			// 2. SVG
			for (const item of items) {
				if (item.types.includes("image/svg+xml")) {
					const blob = await item.getType("image/svg+xml");
					const svgString = await blob.text();
					if (svgString) {
						return this.pasteSvgString(svgString, viewport);
					}
				}
			}

			// 3. Raster image (PNG, JPEG, WebP, etc.)
			for (const item of items) {
				const imgType = item.types.find(
					(t) => t !== "image/svg+xml" && t.startsWith("image/"),
				);
				if (imgType) {
					const blob = await item.getType(imgType);
					const ext = imgType.split("/")[1] ?? "png";
					const file = new File([blob], `pasted-image.${ext}`, {
						type: imgType,
					});
					const id = await this.pasteImageFile(file, viewport);
					return id ? [id] : [];
				}
			}

			// 4. Plain text
			for (const item of items) {
				if (item.types.includes("text/plain")) {
					const blob = await item.getType("text/plain");
					const text = await blob.text();
					if (text) {
						const id = this.pasteText(text, viewport);
						return id ? [id] : [];
					}
				}
			}
		} catch (err) {
			console.warn("Failed to read system clipboard:", err);
		}
		return [];
	}

	/**
	 * Paste plain text as a TextElement at the given viewport position.
	 * Requires `toolSettings` in the CommandContext for default text style.
	 */
	public pasteText(
		text: string,
		viewport?: { x: number; y: number },
	): string | null {
		const toolSettings = this.ctx.toolSettings;
		if (!toolSettings) {
			console.warn(
				"PaplicoCommands.pasteText: toolSettings not provided in CommandContext",
			);
			return null;
		}

		const worldX = viewport?.x ?? 0;
		const worldY = viewport?.y ?? 0;

		const textElement: TextElement = {
			type: "text",
			id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			x: worldX,
			y: worldY,
			transform: createIdentityTransform(),
			content: {
				paragraphs: text.split(/\r?\n/).map((line) => ({
					runs: [
						{
							text: line,
							style: { ...toolSettings.textDefaultStyle },
						},
					],
					alignment: toolSettings.textDefaultAlignment,
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				})),
			},
			defaultStyle: { ...toolSettings.textDefaultStyle },
			layout: {
				writingMode: toolSettings.textDefaultWritingMode,
				boxWidth: "auto",
				boxHeight: "auto",
				overflow: "visible",
				wordWrap: false,
			},
			opacity: 1,
			blendMode: "normal",
		};

		this.addText(textElement);

		// Async: outline the glyphs to compute the world-space bounds, then
		// register them with the spatial index for hit-testing and select the
		// new element so it shows up in the selection UI.
		const textRenderer = this.ctx.getTextRenderer?.();
		if (textRenderer) {
			textRenderer
				.textElementToPaths(textElement)
				.then((result) => {
					this.ctx.spatial.setBounds(textElement.id, result.bounds);
					this.ctx.selection?.selectElement(textElement.id, result.bounds);
				})
				.catch((err) => {
					console.error("Failed to compute text bounds:", err);
				});
		}

		return textElement.id;
	}

	/**
	 * Paste an image File as an ImageObject at the given viewport position.
	 * Embeds the file's bytes via addEmbeddedFile.
	 */
	public async pasteImageFile(
		file: File,
		viewport?: { x: number; y: number },
	): Promise<string | null> {
		const worldX = viewport?.x ?? 0;
		const worldY = viewport?.y ?? 0;

		try {
			const arrayBuffer = await file.arrayBuffer();
			const bin = new Uint8Array(arrayBuffer);

			const hashBuffer = await crypto.subtle.digest("SHA-256", bin);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			const hash = hashArray
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			const embeddedFile: EmbeddedFile = {
				uid: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				name: file.name || "pasted-image.png",
				type: file.type,
				hash,
				bin,
			};

			const fileUid = this.addEmbeddedFile(embeddedFile);

			const imageBitmap = await createImageBitmap(file);
			const imageWidth = imageBitmap.width;
			const imageHeight = imageBitmap.height;
			imageBitmap.close();

			const imageObject: ImageObject = {
				type: "image",
				id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				fileUid,
				x: worldX,
				y: worldY,
				width: imageWidth,
				height: imageHeight,
				transform: createIdentityTransform(),
				opacity: 1,
				blendMode: "normal",
			};

			this.addImage(imageObject);
			return imageObject.id;
		} catch (error) {
			console.error("Failed to paste image:", error);
			return null;
		}
	}

	/**
	 * Paste an SVG string by parsing it to ArtObjects.
	 * Falls back to raster image paste if parsing yields no elements.
	 */
	public async pasteSvgString(
		svgString: string,
		viewport?: { x: number; y: number },
		fallbackImageFile?: File,
	): Promise<string[]> {
		const worldX = viewport?.x ?? 0;
		const worldY = viewport?.y ?? 0;

		try {
			const result = await parseSvgToArtObjects(svgString, worldX, worldY, {
				scaleFilter: (filter, [scaleX, scaleY]) =>
					this.ctx.scaleFilters?.([filter], scaleX, scaleY)[0] ?? filter,
			});
			if (result.topLevelIds.length > 0) {
				const ids = this.addSvgImport(result);
				this.ctx.store.selectedElementIds = ids;
				return ids;
			}
		} catch (err) {
			console.warn("[pasteSvgString] SVG parsing failed:", err);
		}

		if (fallbackImageFile) {
			const id = await this.pasteImageFile(fallbackImageFile, viewport);
			return id ? [id] : [];
		}

		return [];
	}

	/**
	 * Index in the container's stacking order where a paste should go: right
	 * behind or right in front of the anchor siblings, or at the container's
	 * back / top when none of the anchors lives there.
	 */
	private resolvePasteInsertIndex(
		placement: "front" | "back" | undefined,
		anchorIds: readonly string[],
		containerId: string,
		existingCount: number,
	): number {
		if (!placement) return existingCount;
		const siblingIds = containerChildIds(this.ctx.store.document, containerId);
		const anchorIndexes = anchorIds
			.map((id) => siblingIds.indexOf(id))
			.filter((index) => index >= 0);
		if (anchorIndexes.length === 0) {
			return placement === "back" ? 0 : existingCount;
		}
		return placement === "back"
			? Math.min(...anchorIndexes)
			: Math.max(...anchorIndexes) + 1;
	}

	private collectSelectedElements(): {
		elementIds: string[];
		artObjects: AnyArtObject[];
	} {
		return this.collectElementsByIds([...this.ctx.store.selectedElementIds]);
	}

	/**
	 * Deep-clone the given elements plus their absorbed container children
	 * (group children, a blend's source/spine objects) into a flat list.
	 */
	private collectElementsByIds(elementIds: string[]): {
		elementIds: string[];
		artObjects: AnyArtObject[];
	} {
		// Normalize to the current container's stacking (z) order so
		// copy/paste/duplicate preserve the original layer order, independent
		// of selection order (click order or marquee/lasso quadtree traversal
		// order). Mirrors createBlendFromSelection's use of orderSourcesByContainer.
		const parentId =
			this.ctx.store.editingScopeStack.at(-1) ?? this.ctx.store.currentLayerId;
		const orderedIds = parentId
			? orderSourcesByContainer(
					this.ctx.store.document,
					parentId,
					elementIds.map((id) => ({ id })),
				).map((s) => s.id)
			: elementIds;

		const artObjects: AnyArtObject[] = [];

		for (const id of orderedIds) {
			const element = this.ctx.store.document.objects[id];
			if (!element) continue;

			const clone = deepClone(element);
			// Stored transforms of container children are container-local.
			// Normalize top-level clones to world space so every consumer
			// (clipboard payloads, pasteElements → moveIntoContainer's
			// world-space compensation) receives world coordinates regardless
			// of where the source element lived.
			const ancestorT = this.ctx.spatial.getAncestorTransform(id);
			if (ancestorT) {
				clone.transform = composeTransforms(ancestorT, getTransform(clone));
			}
			artObjects.push(clone);
			this.collectAbsorbedDescendants(element, artObjects);
		}

		// Bound axis paths travel with their texts so copy/cut/duplicate are
		// self-contained: paste rebinds via the in-set ID remap instead of
		// leaving the clone anchored to the original path
		const included = new Set(artObjects.map((o) => o.id));
		for (const obj of [...artObjects]) {
			if (obj.type !== "text") continue;
			const axisId = obj.axisBinding?.pathObjectId;
			if (!axisId || included.has(axisId)) continue;
			const path = this.ctx.store.document.objects[axisId];
			if (path?.type !== "path") continue;
			included.add(axisId);
			const clone = deepClone(path);
			const ancestorT = this.ctx.spatial.getAncestorTransform(axisId);
			if (ancestorT) {
				clone.transform = composeTransforms(ancestorT, getTransform(clone));
			}
			artObjects.push(clone);
		}

		// Mask content travels with its owner. Without it the copy's mask keeps
		// pointing at the original's shapes, so the two share one mask and
		// moving either drags the other's.
		//
		// Their transforms are owner-local and stay that way — the world-space
		// normalization above is for elements that will be re-parented into a
		// layer, and mask content never is.
		for (const obj of [...artObjects]) {
			const stack = [...(obj.mask?.elementIds ?? [])];
			for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
				if (included.has(id)) continue;
				const source = this.ctx.store.document.objects[id];
				if (!source) continue;
				included.add(id);
				artObjects.push(deepClone(source));
				for (const childId of getContainerChildIds(source) ?? []) {
					stack.push(childId);
				}
				for (const maskId of source.mask?.elementIds ?? []) stack.push(maskId);
			}
		}

		return { elementIds: orderedIds, artObjects };
	}

	/**
	 * Axis paths referenced by texts in the cut set and by no surviving text:
	 * they are invisible guides that would otherwise linger (and get their
	 * invisibly) after their only bound text is cut.
	 */
	private collectExclusiveAxisPathIds(cutSet: Set<string>): string[] {
		const objects = this.ctx.store.document.objects;
		const candidates = new Set<string>();
		for (const id of cutSet) {
			const obj = objects[id];
			if (
				obj?.type === "text" &&
				obj.axisBinding &&
				!cutSet.has(obj.axisBinding.pathObjectId)
			) {
				candidates.add(obj.axisBinding.pathObjectId);
			}
		}
		if (candidates.size === 0) return [];
		for (const obj of Object.values(objects)) {
			if (obj?.type !== "text" || cutSet.has(obj.id)) continue;
			const bound = obj.axisBinding?.pathObjectId;
			if (bound) candidates.delete(bound);
		}
		return [...candidates];
	}

	private async writeToSystemClipboard(
		elementIds: string[],
		artObjects: AnyArtObject[],
	): Promise<void> {
		try {
			// Build ClipboardItem with Promise<Blob> values to avoid awaiting
			// before navigator.clipboard.write(), which would expire Safari's
			// transient user activation and cause NotAllowedError.
			const itemData: Record<string, string | Blob | Promise<Blob>> = {};

			if (this.ctx.renderElementsToPNG) {
				itemData["image/png"] = this.ctx
					.renderElementsToPNG(elementIds)
					.then(
						(result) => result?.blob ?? new Blob([], { type: "image/png" }),
					);
			}

			if (artObjects.length > 0) {
				itemData[PAPLICO_ELEMENTS_MIME] = new Blob(
					[encodeElementsPayload(artObjects)],
					{ type: PAPLICO_ELEMENTS_MIME },
				);
			}

			if (Object.keys(itemData).length > 0) {
				await Clipboard.write([new ClipboardItem(itemData)]);
			}
		} catch (error) {
			console.warn("Failed to write to system clipboard:", error);
		}
	}

	/**
	 * Paste the given elements into the current layer.
	 *
	 * @param elements - ArtObjects to paste (read from system clipboard).
	 * @param opt.viewport - World-space coordinate used as the center point of the pasted
	 *   elements. The combined bounding box of all pasted elements is computed and each
	 *   anchor point is translated so that the bbox center lands exactly on this position.
	 *   Omit to paste in place (no translation applied).
	 * @param opt.placement - Where the paste lands in its container's stacking
	 *   order. `"back"` puts it right behind the selected element, or behind
	 *   everything when nothing is selected. `"front"` puts it right in front of
	 *   the selected element, or on top of everything when nothing is selected.
	 *   Omit to append on top.
	 * @param opt.placementAnchorIds - Elements `placement` is resolved against
	 *   instead of the selection.
	 * @returns IDs of the newly created elements.
	 */
	public pasteElements(
		elements: AnyArtObject[],
		opt?: {
			viewport?: { x: number; y: number };
			placement?: "front" | "back";
			placementAnchorIds?: readonly string[];
			offset?: { x: number; y: number };
		},
	): string[] {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return [];
		if (elements.length === 0) return [];
		if (!this.ctx.store.currentLayerId) return [];

		const topLevelElements = this.getTopLevelElements(elements);

		let offsetX = 0;
		let offsetY = 0;
		if (opt?.offset != null) {
			// Direct offset (e.g. alt-drag duplicate) — takes precedence.
			offsetX = opt.offset.x;
			offsetY = opt.offset.y;
		} else if (opt?.viewport != null) {
			const bbox = this.calculateCombinedBounds(topLevelElements, elements);
			offsetX = opt.viewport.x - (bbox.minX + bbox.maxX) / 2;
			offsetY = opt.viewport.y - (bbox.minY + bbox.maxY) / 2;
		}

		// Placement is resolved against whatever the paste lands in: the group
		// the paste is pulled into, otherwise the layer. Pasted elements are
		// appended, so their indexes follow the existing ones until they are
		// moved to the resolved insertion point.
		const anchorIds =
			opt?.placementAnchorIds ?? this.ctx.store.selectedElementIds;
		const pasteGroupId = this.resolvePasteGroupId(opt?.placement, anchorIds);
		const targetContainerId = pasteGroupId ?? this.getEditingScopeContainerId();
		const landingContainerId = pasteGroupId ?? this.ctx.store.currentLayerId;
		const existingCount = containerChildIds(
			this.ctx.store.document,
			landingContainerId,
		).length;
		const insertAt = this.resolvePasteInsertIndex(
			opt?.placement,
			anchorIds,
			landingContainerId,
			existingCount,
		);

		// Centralize deep-clone + ID remap (containers / blend / compound-path /
		// text path-binding) in cloneElementsWithIdRemap. Preserve the original
		// "${type}-${Date.now()}-${rand9}" ID format used by paste so external
		// consumers of pasted IDs see unchanged shape.
		const now = Date.now();
		const { cloned, idMap } = cloneElementsWithIdRemap(elements, {
			mintId: (el) =>
				`${el.type}-${now}-${Math.random().toString(36).slice(2, 9)}`,
		});
		// A ref to a preset this document does not have (cross-document paste)
		// has nothing to draw, so it is dropped.
		const presets = createAppearancePresetsMap(this.ctx.store.document);
		for (const element of cloned) {
			const filters = dropDanglingPresetRefs(element.filters, presets);
			if (filters) element.filters = filters;
		}
		const clonedById = new Map<string, AnyArtObject>();
		for (let i = 0; i < elements.length; i++) {
			clonedById.set(elements[i]!.id, cloned[i]!);
		}

		const translate = (el: AnyArtObject): AnyArtObject =>
			translateClonedElement(el, offsetX, offsetY);

		// Mask content is reachable only through its owner's `mask`, so it is
		// registered as an object and never listed anywhere. Untranslated: its
		// coordinates are owner-local and the owner carries the paste offset.
		const byId = new Map(elements.map((el) => [el.id, el]));
		const maskContentIds = new Set<string>();
		const maskStack = elements.flatMap((el) => el.mask?.elementIds ?? []);
		for (let id = maskStack.pop(); id !== undefined; id = maskStack.pop()) {
			if (maskContentIds.has(id)) continue;
			const element = byId.get(id);
			if (!element) continue;
			maskContentIds.add(id);
			for (const childId of getContainerChildIds(element) ?? []) {
				maskStack.push(childId);
			}
			for (const nested of element.mask?.elementIds ?? []) {
				maskStack.push(nested);
			}
		}
		if (maskContentIds.size > 0) {
			this.ctx.yjsProvider.transact(() => {
				for (const element of elements) {
					if (!maskContentIds.has(element.id)) continue;
					const clone = clonedById.get(element.id);
					if (!clone) continue;
					this.ctx.yjsProvider.addObjectOnly(clone, this.getMutationOrigin());
				}
			}, this.getMutationOrigin());
		}

		const newTopLevelIds: string[] = [];

		for (const element of topLevelElements) {
			const newId = idMap.get(element.id)!;

			if (element.type === "group") {
				const clonedGroup = clonedById.get(element.id) as Group;
				const layerId = this.ctx.store.currentLayerId!;
				const clonedChildren: AnyArtObject[] = [];
				// Everything below a direct child (a nested group's members, a
				// nested mesh's warped children) is absorbed: reachable only
				// through its own container's childIds, never listed in a layer.
				// Untranslated — their coordinates are container-local and the
				// direct child carries the paste offset.
				const nestedDescendants: AnyArtObject[] = [];

				// Clone children before transaction because `elements` is a Valtio proxy
				// that may mutate during transact() via syncYjsToValtio.
				for (const childId of element.childIds) {
					const childClone = clonedById.get(childId);
					if (!childClone) continue;
					clonedChildren.push(translate(childClone));
					const original = byId.get(childId);
					if (!original) continue;
					nestedDescendants.push(
						...collectClonedDescendants(
							getContainerChildIds(original) ?? [],
							byId,
							clonedById,
						),
					);
				}

				this.ctx.yjsProvider.transact(() => {
					for (const descendant of nestedDescendants) {
						this.ctx.yjsProvider.addObjectOnly(
							descendant,
							this.getMutationOrigin(),
						);
					}
					this.ctx.yjsProvider.addElement(
						layerId,
						clonedGroup,
						this.getMutationOrigin(),
					);

					for (const clonedChild of clonedChildren) {
						this.ctx.yjsProvider.addElement(
							layerId,
							clonedChild,
							this.getMutationOrigin(),
						);
						this.ctx.yjsProvider.addElementToGroup(
							layerId,
							newId,
							clonedChild.id,
							this.getMutationOrigin(),
						);
					}

					// Move the pasted group into its container (after children are settled)
					this.moveIntoContainer(layerId, clonedGroup, targetContainerId);
				}, this.getMutationOrigin());

				newTopLevelIds.push(newId);
			} else if (element.type === "mesh") {
				const layerId = this.ctx.store.currentLayerId!;
				const clonedMesh = clonedById.get(element.id) as MeshArtObject;
				// A mesh container's children (and everything under them) are
				// absorbed: reachable only through childIds, never listed in a
				// layer. Untranslated — their coordinates are container-local
				// and the container carries the paste offset.
				const descendants = collectClonedDescendants(
					element.childIds,
					byId,
					clonedById,
				);
				this.ctx.yjsProvider.transact(() => {
					for (const descendant of descendants) {
						this.ctx.yjsProvider.addObjectOnly(
							descendant,
							this.getMutationOrigin(),
						);
					}
					this.ctx.yjsProvider.addElement(
						layerId,
						clonedMesh,
						this.getMutationOrigin(),
					);
					this.moveIntoContainer(
						layerId,
						clonedMesh,
						targetContainerId,
						new Map(descendants.map((d) => [d.id, d])),
					);
				}, this.getMutationOrigin());
				newTopLevelIds.push(newId);
			} else if (element.type === "blend") {
				const blendLayerId = this.ctx.store.currentLayerId!;
				const sourceIds = element.spineSourceId
					? [...element.objectIds, element.spineSourceId]
					: element.objectIds;
				// Clone each source with a fresh id so the copy owns independent
				// source objects; otherwise both blends reference the same sources
				// and editing one is reflected in the other.
				const clonedSources: AnyArtObject[] = [];
				for (const srcId of sourceIds) {
					const srcClone = clonedById.get(srcId);
					if (!srcClone) continue;
					clonedSources.push(translate(srcClone));
				}
				const clonedBlend = clonedById.get(element.id) as BlendObject;
				this.ctx.yjsProvider.transact(() => {
					// Add the cloned sources, then createBlend absorbs them into the
					// new blend (same absorption path as creation).
					for (const clonedSource of clonedSources) {
						this.ctx.yjsProvider.addElement(
							blendLayerId,
							clonedSource,
							this.getMutationOrigin(),
						);
					}
					this.ctx.yjsProvider.createBlend(blendLayerId, clonedBlend);
					this.moveIntoContainer(
						blendLayerId,
						clonedBlend,
						targetContainerId,
						new Map(clonedSources.map((source) => [source.id, source])),
					);
				}, this.getMutationOrigin());
				newTopLevelIds.push(newId);
			} else {
				const clone = clonedById.get(element.id)!;
				// A compound path's / repeat's sources are absorbed like a
				// container's children: registered as objects, never listed in a
				// layer, untranslated — the owner carries the paste offset.
				const absorbed = collectClonedDescendants(
					getContainerChildIds(element) ?? [],
					byId,
					clonedById,
				);
				this.ctx.yjsProvider.transact(() => {
					for (const descendant of absorbed) {
						this.ctx.yjsProvider.addObjectOnly(
							descendant,
							this.getMutationOrigin(),
						);
					}
					this.addElementInto(translate(clone), targetContainerId);
				}, this.getMutationOrigin());
				newTopLevelIds.push(newId);
			}
		}

		if (this.ctx.selection) this.ctx.selection.selectMultiple(newTopLevelIds);
		else this.ctx.store.selectedElementIds = newTopLevelIds;

		if (insertAt !== existingCount) {
			for (let i = 0; i < newTopLevelIds.length; i++) {
				if (landingContainerId === this.ctx.store.currentLayerId) {
					this.ctx.yjsProvider.reorderElements(
						landingContainerId,
						existingCount + i,
						insertAt + i,
						this.getMutationOrigin(),
					);
				} else {
					this.ctx.yjsProvider.reorderGroupChildren(
						landingContainerId,
						existingCount + i,
						insertAt + i,
					);
				}
			}
		}

		return newTopLevelIds;
	}

	/**
	 * Collect everything a container absorbs (group members, a mesh warp
	 * container's warped children, a compound path's / repeat's sources, a
	 * blend's sources and spine), at any depth, so copy/duplicate payloads
	 * are self-contained — without them the clone's references would keep
	 * pointing at the original's objects and the two would share (and
	 * co-edit) them, or dangle when pasted into another document.
	 */
	private collectAbsorbedDescendants(
		container: AnyArtObject,
		out: AnyArtObject[],
	): void {
		for (const childId of getContainerChildIds(container) ?? []) {
			const child = this.ctx.store.document.objects[childId];
			if (!child) continue;
			out.push(deepClone(child));
			this.collectAbsorbedDescendants(child, out);
		}
	}

	private getTopLevelElements(elements: AnyArtObject[]): AnyArtObject[] {
		// Elements that are NOT absorbed by any container in the list.
		const childIds = new Set<string>();
		for (const el of elements) {
			// Mask content is owned by its element and belongs to no layer, so it
			// must not be pasted as an element of its own.
			for (const maskId of el.mask?.elementIds ?? []) childIds.add(maskId);
			for (const cid of getContainerChildIds(el) ?? []) childIds.add(cid);
		}
		return elements.filter((el) => !childIds.has(el.id));
	}

	private calculateCombinedBounds(
		topLevel: AnyArtObject[],
		allElements: AnyArtObject[],
	): {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	} {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		const elementsMap = new Map(allElements.map((e) => [e.id, e]));

		for (const el of topLevel) {
			const b = calculateElementBounds(el, elementsMap);
			if (b.minX < minX) minX = b.minX;
			if (b.minY < minY) minY = b.minY;
			if (b.maxX > maxX) maxX = b.maxX;
			if (b.maxY > maxY) maxY = b.maxY;
		}

		if (!Number.isFinite(minX)) {
			return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		}
		return { minX, minY, maxX, maxY };
	}

	/**
	 * The group a paste lands in. A placed paste joins the group its anchor
	 * element lives in: a member selected directly inside a group (path edit
	 * tool) is not a layer sibling, so placing the paste beside it means
	 * entering its group. Otherwise the editing scope's group, when one is
	 * active.
	 */
	private resolvePasteGroupId(
		placement: "front" | "back" | undefined,
		anchorIds: readonly string[],
	): string | null {
		if (placement) {
			for (const id of anchorIds) {
				const parentGroupId = this.ctx.spatial.getParentGroupId(id);
				if (parentGroupId) return parentGroupId;
			}
		}
		const scopeContainerId = this.getEditingScopeContainerId();
		if (!scopeContainerId) return null;
		const scopeContainer = this.ctx.store.document.objects[scopeContainerId];
		return scopeContainer && isGroup(scopeContainer) ? scopeContainerId : null;
	}

	/** Adds a pasted element to the current layer, then into its container. */
	private addElementInto(
		element: AnyArtObject,
		targetContainerId: string | null,
	): void {
		if (!this.ctx.store.currentLayerId) return;
		const layerId = this.ctx.store.currentLayerId;
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(
				layerId,
				element,
				this.getMutationOrigin(),
			);
			this.moveIntoContainer(layerId, element, targetContainerId);
		}, this.getMutationOrigin());
	}

	// --- Undo/Redo ---

	public undo(): void {
		if (this.cannotMutate()) return;
		const session = this.ctx.getSessionHistory?.();
		if (session) {
			session.undo();
			return;
		}
		this.ctx.yjsProvider.undo();
	}

	public redo(): void {
		if (this.cannotMutate()) return;
		const session = this.ctx.getSessionHistory?.();
		if (session) {
			session.redo();
			return;
		}
		this.ctx.yjsProvider.redo();
	}

	public updateUndoRedoState(): void {
		this.ctx.store.canUndo = this.ctx.yjsProvider.canUndo();
		this.ctx.store.canRedo = this.ctx.yjsProvider.canRedo();
	}

	public startAdjustColorSession(): AdjustColorSession | null {
		if (this.cannotMutate()) return null;
		const originals = new Map<string, AnyArtObject>();

		const collect = (id: string) => {
			const obj = this.ctx.store.document.objects[id];
			if (!obj) return;
			originals.set(id, deepClone(obj));
			if (obj.type === "group") {
				for (const childId of obj.childIds) collect(childId);
			} else if (isBlend(obj)) {
				// A blend has no paint of its own; its colors live on the absorbed
				// key objects (intermediates interpolate from them). Recurse into the
				// keys so color adjustment reaches the blend.
				for (const keyId of obj.objectIds) collect(keyId);
			} else if (isRepeat(obj)) {
				// A repeat has no paint of its own; its instances are copies of the
				// absorbed sources. Recurse into the sources so color adjustment
				// reaches every instance.
				for (const sourceId of obj.sourceIds) collect(sourceId);
			}
		};

		for (const id of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(id)) continue;
			collect(id);
		}
		if (originals.size === 0) return null;

		return new AdjustColorSession(
			originals,
			this.ctx.yjsProvider,
			this.getMutationOrigin(),
			this.ctx.filterHandlerLookup,
		);
	}

	// --- YjsProvider delegation (for ToolContext) ---

	public transact(fn: (commands: PaplicoCommands) => void): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.transact(() => fn(this), this.getMutationOrigin());
	}

	public addElementToLayer(layerId: string, element: AnyArtObject): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(
				layerId,
				element,
				this.getMutationOrigin(),
			);
			this.moveIntoEditingScope(layerId, element);
		}, this.getMutationOrigin());
	}

	public addObjectToDocument(element: AnyArtObject): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addObjectOnly(element, this.getMutationOrigin());
	}

	// --- Reference3D (shared 3D scene definitions + viewing elements) ---

	/**
	 * Create a fresh shared 3D scene (floor + one box as a starting point) and
	 * a Reference3DElement viewing it, centered at world (x, y). One transaction =
	 * one undo step removing both.
	 */
	public createReference3DScene(
		x: number,
		y: number,
		width = 400,
		height = 300,
	): Reference3DElement | null {
		const layerId = this.ctx.store.currentLayerId;
		if (this.cannotMutate() || !layerId || this.isLayerLocked(layerId)) {
			return null;
		}

		const def: Reference3DDef = {
			id: generateUid("scene"),
			nodes: [
				{
					id: generateUid("node"),
					kind: "primitive",
					shape: "box",
					transform: {
						position: [0, 0.5, 0],
						rotation: [0, 0, 0, 1],
						scale: [1, 1, 1],
					},
				},
			],
		};
		const element = createReference3DElement({
			sceneId: def.id,
			x,
			y,
			width,
			height,
		});

		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.setReference3D(def, this.getMutationOrigin());
			this.ctx.yjsProvider.addElement(
				layerId,
				element,
				this.getMutationOrigin(),
			);
		}, this.getMutationOrigin());

		return element;
	}

	/** Append a node to a shared scene definition. */
	/** Rename a shared 3D scene definition (empty name clears it). */
	public renameReference3DScene(sceneId: string, name: string): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		const trimmed = name.trim();
		if ((def.name ?? "") === trimmed) return;
		this.ctx.yjsProvider.setReference3D(
			{ ...def, name: trimmed || undefined },
			this.getMutationOrigin(),
		);
	}

	public reference3dAddNode(sceneId: string, node: Reference3DNode): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			[...def.nodes, node],
			this.getMutationOrigin(),
		);
	}

	/** Remove a node from a shared scene definition (one undo step). */
	public reference3dRemoveNode(sceneId: string, nodeId: string): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		const nodes = def.nodes.filter((node) => node.id !== nodeId);
		if (nodes.length === def.nodes.length) return;
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			nodes,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Duplicate a node in a shared scene definition with a small position
	 * offset (one undo step). Returns the new node, or null when missing.
	 */
	public reference3dDuplicateNode(
		sceneId: string,
		nodeId: string,
	): Reference3DNode | null {
		if (this.cannotMutate()) return null;
		const def = this.ctx.store.document.references3d?.[sceneId];
		const source = def?.nodes.find((node) => node.id === nodeId);
		if (!def || !source) return null;

		const duplicate: Reference3DNode = {
			...structuredClone(source),
			id: generateUid("node"),
		};
		duplicate.transform = {
			...duplicate.transform,
			position: [
				duplicate.transform.position[0] + 0.3,
				duplicate.transform.position[1],
				duplicate.transform.position[2] + 0.3,
			],
		};
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			[...def.nodes, duplicate],
			this.getMutationOrigin(),
		);
		return duplicate;
	}

	/** Patch a single node of a shared scene definition (one undo step). */
	public reference3dCommitNode(
		sceneId: string,
		nodeId: string,
		patch: Partial<Reference3DNode>,
	): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		const nodes = def.nodes.map((node) =>
			node.id === nodeId ? ({ ...node, ...patch } as Reference3DNode) : node,
		);
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			nodes,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Store a VRM binary as an EmbeddedFile (hash-deduplicated) and append a
	 * figure node referencing it, in one transaction (= one undo step).
	 */
	public reference3dAddFigure(
		sceneId: string,
		file: EmbeddedFile,
	): Reference3DNode | null {
		return this.reference3dAppendFileNode(sceneId, file, (fileUid) => ({
			id: generateUid("node"),
			kind: "figure",
			fileUid,
			transform: {
				position: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
			pose: { bones: {} },
		}));
	}

	/**
	 * Store a glTF binary (.glb) as an EmbeddedFile (hash-deduplicated) and
	 * append a static mesh node referencing it, in one transaction.
	 */
	public reference3dAddMesh(
		sceneId: string,
		file: EmbeddedFile,
	): Reference3DNode | null {
		return this.reference3dAppendFileNode(sceneId, file, (fileUid) => ({
			id: generateUid("node"),
			kind: "mesh",
			fileUid,
			transform: {
				position: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
		}));
	}

	private reference3dAppendFileNode(
		sceneId: string,
		file: EmbeddedFile,
		buildNode: (fileUid: string) => Reference3DNode,
	): Reference3DNode | null {
		if (this.cannotMutate()) return null;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return null;

		let node: Reference3DNode | null = null;
		this.ctx.yjsProvider.transact(() => {
			node = buildNode(this.ctx.yjsProvider.addFile(file));
			this.ctx.yjsProvider.updateReference3DNodes(
				sceneId,
				[...def.nodes, node],
				this.getMutationOrigin(),
			);
		}, this.getMutationOrigin());

		return node;
	}

	private splitPath(
		layerId: string,
		pathId: string,
		segmentIndex: number,
		pointType: "start" | "end",
	): void {
		if (this.cannotMutate() || this.isElementLocked(pathId)) return;
		this.ctx.yjsProvider.splitPath(
			layerId,
			pathId,
			segmentIndex,
			pointType,
			this.getMutationOrigin(),
		);
	}

	/** Replace a path with several paths built from the given segment runs. */
	public replacePathWithPaths(
		layerId: string,
		pathId: string,
		runs: PathRun[],
	): void {
		if (this.cannotMutate() || this.isElementLocked(pathId)) return;
		this.ctx.yjsProvider.replacePathWithPaths(
			layerId,
			pathId,
			runs,
			this.getMutationOrigin(),
		);
	}

	public splitPathAtAnchor(
		pathId: string,
		segmentIndex: number,
		pointType: "start" | "end",
	): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.splitPath(layerId, pathId, segmentIndex, pointType);
	}

	/** Close an open path with a straight segment from its end anchor to its start anchor. */
	public closePath(pathId: string): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		const element = this.ctx.store.document.objects[pathId];
		if (element?.type !== "path") return;
		const segments = closePathAtEndpoints(element.segments);
		if (!segments) return;
		this.updateElement(layerId, pathId, { segments });
	}

	/**
	 * Store a path's segments in world coordinates so points taken from the
	 * canvas can be appended to them as-is.
	 */
	public bakePathToWorld(pathId: string): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		const element = this.ctx.store.document.objects[pathId];
		if (element?.type !== "path") return;
		const ancestorT = this.ctx.spatial.getAncestorTransform(pathId);
		const elementT = getTransform(element);
		const t = ancestorT ? composeTransforms(ancestorT, elementT) : elementT;
		if (isIdentityTransform(t)) return;
		this.updateElement(layerId, pathId, this.bakeWorldGeometry(element));
	}

	public mergePaths(
		pathIdA: string,
		endpointA: "start" | "end",
		pathIdB: string,
		endpointB: "start" | "end",
	): void {
		if (this.cannotMutate()) return;
		if (this.isElementLocked(pathIdA) || this.isElementLocked(pathIdB)) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.ctx.yjsProvider.mergePaths(
			layerId,
			pathIdA,
			endpointA,
			pathIdB,
			endpointB,
			this.getMutationOrigin(),
		);
	}

	/** Close the open history entry, in the editing session when one is open. */
	public stopUndoCapture(): void {
		const session = this.ctx.getSessionHistory?.();
		if (session) session.stopCapture();
		else this.ctx.yjsProvider.stopUndoCapture();
	}

	public addPaths(
		paths: Path[],
		insertIndex?: number,
		targetLayerId?: string,
	): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		if (insertIndex !== undefined) {
			const layerId = targetLayerId ?? this.ctx.store.currentLayerId;
			if (!layerId) return;
			const origin = this.getMutationOrigin();
			this.ctx.yjsProvider.transact(() => {
				for (const [offset, path] of paths.entries()) {
					this.ctx.yjsProvider.addElement(
						layerId,
						path,
						origin,
						insertIndex + offset,
					);
				}
			}, origin);
			return;
		}

		for (const path of paths) {
			this.addPath(path);
		}
	}

	/**
	 * Add paths as children of a group or mesh, or as sources of a compound
	 * path. `sourceOp` is the boolean operation given to compound path sources.
	 */
	public addPathsToContainer(
		paths: Path[],
		containerId: string,
		insertIndex?: number,
		targetLayerId?: string,
		sourceOp: BooleanOperation = "union",
	): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		const layerId = targetLayerId ?? this.ctx.store.currentLayerId;
		if (!layerId) return;
		const container = this.ctx.store.document.objects[containerId];
		if (!container) return;
		const origin = this.getMutationOrigin();

		this.ctx.yjsProvider.transact(() => {
			for (const [offset, path] of paths.entries()) {
				const index =
					insertIndex === undefined ? undefined : insertIndex + offset;
				this.ctx.yjsProvider.addElement(layerId, path, origin);
				if (isCompoundPath(container)) {
					this.ctx.yjsProvider.addSourceToCompoundPath(
						layerId,
						containerId,
						path.id,
						sourceOp,
						origin,
						index,
					);
				} else {
					this.ctx.yjsProvider.addElementToGroup(
						layerId,
						containerId,
						path.id,
						origin,
						index,
					);
				}
			}
		}, origin);
	}
}

export class AdjustColorSession {
	public readonly collectedColors: CollectedColor[];
	private disposed = false;

	public constructor(
		private originalElements: Map<string, AnyArtObject>,
		private yjsProvider: YjsProvider,
		private origin?: unknown,
		private filterHandlerLookup?: FilterHandlerLookup,
	) {
		this.collectedColors = [...originalElements.entries()]
			.flatMap(([id, el]) =>
				collectElementColors(id, el, this.filterHandlerLookup),
			)
			.map((c, i) => ({ ...c, index: i }));
		this.yjsProvider.stopUndoCapture();
	}

	public preview(adjuster: (color: Color) => Color): CollectedColor[] {
		if (this.disposed) return this.collectedColors;

		const updates = [...this.originalElements.entries()].map(([id, el]) => ({
			elementId: id,
			updates: buildElementColorUpdates(el, adjuster, this.filterHandlerLookup),
		}));

		this.yjsProvider.batchUpdateElements(updates, this.origin);

		return this.collectedColors.map((cc) => ({
			...cc,
			color: adjuster(cc.color),
		}));
	}

	public apply(): void {
		if (this.disposed) return;
		this.yjsProvider.stopUndoCapture();
		this.disposed = true;
	}

	public cancel(): void {
		if (this.disposed) return;

		const updates = [...this.originalElements.entries()].map(([id, el]) => ({
			elementId: id,
			updates: {
				filters: el.filters,
			} as Partial<AnyArtObject>,
		}));

		this.yjsProvider.batchUpdateElements(updates, this.origin);
		this.yjsProvider.stopUndoCapture();
		// Undo the preview changes
		this.yjsProvider.undo();
		this.disposed = true;
	}
}

/** Center of each element in its own (container-local) space. */
function blendKeyCenters(
	keys: AnyArtObject[],
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Array<{ x: number; y: number }> {
	return keys.map((key) => {
		const b = calculateElementBounds(key, elementsMap);
		return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
	});
}

/** Straight polyline segments through the given points (in order, ≥2). */
function polylineSpineSegments(
	centers: Array<{ x: number; y: number }>,
): PathSegment[] {
	const segments: PathSegment[] = [];
	for (let i = 1; i < centers.length; i++) {
		segments.push({
			start: i === 1 ? { x: centers[0].x, y: centers[0].y } : undefined,
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: centers[i].x, y: centers[i].y },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 1,
		});
	}
	return segments;
}

/**
 * Default blend spine: a polyline through the key centers (in order). The keys
 * are the spine's vertices, so the spine bends through every key and moving a
 * key reshapes it. Returns null for fewer than two keys.
 */
function buildBlendSpineThroughKeys(
	keys: AnyArtObject[],
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Path | null {
	if (keys.length < 2) return null;
	return {
		type: "path",
		id: generateUid("path"),
		segments: polylineSpineSegments(blendKeyCenters(keys, elementsMap)),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

/**
 * Resolve the single parent container (layer or group) that directly holds every
 * blend source. Returns the parent id (a layer id or a group id) on success, or
 * a "different-parent" error when sources do not all share one container.
 */
/** Round every numeric field of a params object to 3 decimals, leaving
 *  non-numeric fields (e.g. booleans) untouched. */
function roundNumericFields<T extends Record<string, unknown>>(obj: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		out[key] =
			typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
	}
	return out as T;
}

function resolveBlendSourceContainer(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	sourceIds: readonly string[],
): { ok: true; parentId: string } | { ok: false; reason: "different-parent" } {
	let parentId: string | null = null;
	for (const id of sourceIds) {
		const container = findDirectContainerId(document, id);
		if (!container) return { ok: false, reason: "different-parent" };
		if (parentId === null) parentId = container;
		else if (parentId !== container)
			return { ok: false, reason: "different-parent" };
	}
	if (parentId === null) return { ok: false, reason: "different-parent" };
	return { ok: true, parentId };
}

/**
 * Reorder `sources` to match the parent container's child ordering (a layer's
 * elementIds or a group's childIds), i.e. the document stacking (z) order. All
 * sources are guaranteed (by resolveBlendSourceContainer) to be direct children
 * of `parentId`, so each is found in the container's id list.
 */
function orderSourcesByContainer<T extends { id: string }>(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	parentId: string,
	sources: readonly T[],
): T[] {
	const layer = document.layers.find((l) => l.id === parentId);
	const orderedIds =
		layer?.elementIds ?? getContainerChildIds(document.objects[parentId]) ?? [];
	const rank = new Map(orderedIds.map((id, i) => [id, i]));
	return [...sources].sort(
		(a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
	);
}

/**
 * Find the id of the container directly holding `id`: the layer whose
 * elementIds lists it, or the group whose childIds lists it. Returns null when
 * the element is not a direct child of any layer or group.
 */
function findDirectContainerId(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	id: string,
): string | null {
	const layer = document.layers.find((l) => l.elementIds.includes(id));
	if (layer) return layer.id;
	for (const obj of Object.values(document.objects)) {
		if (isGroup(obj) && obj.childIds.includes(id)) return obj.id;
	}
	return null;
}

/** True when `element` or any descendant would pass through the cage unwarped. */
function hasPassthroughDescendant(
	element: AnyArtObject,
	objects: Record<string, AnyArtObject>,
	visited = new Set<string>(),
): boolean {
	if (visited.has(element.id)) return false;
	visited.add(element.id);
	if (isMeshWarpPassthrough(element)) return true;
	return (getContainerChildIds(element) ?? []).some((id) => {
		const child = objects[id];
		return (
			child !== undefined && hasPassthroughDescendant(child, objects, visited)
		);
	});
}

/**
 * The transforms a released mesh's children need in the parent's space to
 * stay where the mesh drew them. Empty when the mesh transform is identity
 * and nothing moves.
 */
function releasedChildTransforms(
	mesh: MeshArtObject,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Map<string, ElementTransform> {
	const result = new Map<string, ElementTransform>();
	const meshTransform = getTransform(mesh);
	if (isIdentityTransform(meshTransform)) return result;
	for (const id of mesh.childIds) {
		const child = elementsMap.get(id);
		if (!child) continue;
		result.set(id, composeTransforms(meshTransform, getTransform(child)));
	}
	return result;
}

/**
 * Applies a world-space offset to a freshly cloned element (i.e. one returned by
 * cloneElementsWithIdRemap). Only translates element types whose anchor lives
 * directly on the element (path segments, image x/y, text x/y). Container-like
 * types (group / blend / compound-path / mesh) carry no anchor of their own and
 * are returned unchanged; their internal sources are translated separately by
 * the caller.
 */
function translateClonedElement(
	element: AnyArtObject,
	offsetX: number,
	offsetY: number,
): AnyArtObject {
	if (offsetX === 0 && offsetY === 0) return element;
	if (element.type === "path") {
		return {
			...element,
			segments: translateSegments(element.segments, offsetX, offsetY),
		} satisfies Path;
	}
	if (element.type === "image" || element.type === "text") {
		return { ...element, x: element.x + offsetX, y: element.y + offsetY };
	}
	// Containers and compound paths carry the offset on their own transform;
	// the absorbed children / sources stay in their stored coordinates, the
	// same way a move shifts only the owner.
	if (
		element.type === "group" ||
		element.type === "mesh" ||
		element.type === "compound-path"
	) {
		const transform = getTransform(element);
		return {
			...element,
			transform: {
				...transform,
				x: transform.x + offsetX,
				y: transform.y + offsetY,
			},
		};
	}
	return element;
}

/**
 * Clones of the given ids and of everything reachable below them through
 * container childIds, so a pasted container brings its whole subtree.
 */
function collectClonedDescendants(
	rootIds: readonly string[],
	byId: Map<string, AnyArtObject>,
	clonedById: Map<string, AnyArtObject>,
): AnyArtObject[] {
	const descendants: AnyArtObject[] = [];
	const stack = [...rootIds];
	for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
		const clone = clonedById.get(id);
		if (clone) descendants.push(clone);
		const original = byId.get(id);
		if (!original) continue;
		for (const childId of getContainerChildIds(original) ?? []) {
			stack.push(childId);
		}
	}
	return descendants;
}

/** Absolute area of a quad (shoelace formula). */
function quadArea(quad: [Vec2, Vec2, Vec2, Vec2]): number {
	let area = 0;
	for (let i = 0; i < 4; i++) {
		const [x1, y1] = quad[i];
		const [x2, y2] = quad[(i + 1) % 4];
		area += x1 * y2 - x2 * y1;
	}
	return Math.abs(area / 2);
}

/**
 * Display-ordered ids held directly by a container, whether that container is
 * a layer or a group. Index 0 renders first, so later entries sit on top.
 */
function containerChildIds(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	containerId: string,
): readonly string[] {
	const layer = document.layers.find((l) => l.id === containerId);
	if (layer) return layer.elementIds;
	const container = document.objects[containerId];
	return container && isGroup(container) ? container.childIds : [];
}
