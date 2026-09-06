import type * as Y from "yjs";
import type { ProofProfileRef, RenderingIntent } from "../color/types";
import { createIdentityTransform } from "../document/factory";
import {
	type AnyArtObject,
	type AppearancePreset,
	type Artboard,
	type BlendMode,
	type BlendObject,
	type BrushPreset,
	type ColorProfileSettings,
	type CompositionMode,
	type CompoundPath,
	type DefEntry,
	type DefKind,
	type Document,
	type ElementTransform,
	type EmbeddedFile,
	type Filter,
	type Group,
	type ImageObject,
	isTransientLayerKind,
	type Layer,
	type MeshArtObject,
	normalizeAppearanceFields,
	type ObjectMask,
	type Path,
	type Reference3DDef,
	type Reference3DElement,
	type RepeatObject,
	type TextElement,
} from "../schema";
import { safeJSONParse } from "../utils/lang";

interface SerializedEmbeddedFile {
	uid: string;
	name: string;
	type: string;
	hash: string;
	bin: Uint8Array | number[];
}

/**
 * Y.Map<unknown> から AnyArtObject に変換する。
 * type フィールドに基づいて適切な型にデシリアライズする。
 *
 * JSON.parse で復元するフィールド: segments, childIds, sources,
 * filters, color, fill, brushSettings, content, defaultStyle, layout, axisBinding, flow
 */
export function yMapToObject(yMap: Y.Map<unknown>): AnyArtObject {
	const type = yMap.get("type") as string;

	const base = {
		id: yMap.get("id") as string,
		opacity: (yMap.get("opacity") as number) ?? 1,
		blendMode: (yMap.get("blendMode") as BlendMode | undefined) ?? "normal",
		compositionMode: yMap.get("compositionMode") as CompositionMode | undefined,
		visible: yMap.get("visible") as boolean | undefined,
		locked: yMap.get("locked") as boolean | undefined,
		filters: yMap.has("filters")
			? (normalizeAppearanceFields(
					JSON.parse(yMap.get("filters") as string),
				) as Filter[])
			: undefined,
		transform: (yMap.has("transform")
			? JSON.parse(yMap.get("transform") as string)
			: createIdentityTransform()) as ElementTransform,
		mask: yMap.has("mask")
			? (JSON.parse(yMap.get("mask") as string) as ObjectMask)
			: undefined,
	};

	switch (type) {
		case "path":
			return {
				...base,
				type: "path",
				segments: JSON.parse(yMap.get("segments") as string),
				strokeWidths: yMap.has("strokeWidths")
					? JSON.parse(yMap.get("strokeWidths") as string)
					: undefined,
				strokeWidthsBaked: yMap.get("strokeWidthsBaked") as boolean | undefined,
				eraseMasks: yMap.has("eraseMasks")
					? JSON.parse(yMap.get("eraseMasks") as string)
					: undefined,
				pathStart: yMap.get("pathStart") as number | undefined,
				pathEnd: yMap.get("pathEnd") as number | undefined,
				isGuide: yMap.get("isGuide") as boolean | undefined,
			} satisfies Path;

		case "group":
			return {
				...base,
				type: "group",
				childIds: JSON.parse(yMap.get("childIds") as string),
				name: yMap.get("name") as string | undefined,
				collapsed: yMap.get("collapsed") as boolean | undefined,
				clipPathId: yMap.get("clipPathId") as string | null | undefined,
			} satisfies Group;

		case "image":
			return {
				...base,
				type: "image",
				fileUid: yMap.get("fileUid") as string,
				x: yMap.get("x") as number,
				y: yMap.get("y") as number,
				width: yMap.get("width") as number,
				height: yMap.get("height") as number,
				corners: yMap.has("corners")
					? JSON.parse(yMap.get("corners") as string)
					: undefined,
			} satisfies ImageObject;

		case "compound-path":
			return {
				...base,
				type: "compound-path",
				sources: JSON.parse(yMap.get("sources") as string),
			} satisfies CompoundPath;

		case "text":
			return {
				...base,
				type: "text",
				x: yMap.get("x") as number,
				y: yMap.get("y") as number,
				content: JSON.parse(yMap.get("content") as string),
				defaultStyle: JSON.parse(yMap.get("defaultStyle") as string),
				layout: JSON.parse(yMap.get("layout") as string),
				axisBinding: yMap.has("axisBinding")
					? JSON.parse(yMap.get("axisBinding") as string)
					: undefined,
				flow: yMap.has("flow")
					? JSON.parse(yMap.get("flow") as string)
					: undefined,
				clipPathId: yMap.get("clipPathId") as string | null | undefined,
			} satisfies TextElement;

		case "mesh":
			return {
				...base,
				type: "mesh",
				name: yMap.get("name") as string | undefined,
				childIds: JSON.parse(yMap.get("childIds") as string),
				vertices: JSON.parse(yMap.get("vertices") as string),
				faces: JSON.parse(yMap.get("faces") as string),
			} satisfies MeshArtObject;

		case "blend": {
			const renderOrderRaw = yMap.get("renderOrder") as string | undefined;
			return {
				...base,
				type: "blend",
				objectIds: JSON.parse(yMap.get("objectIds") as string),
				renderOrder: renderOrderRaw ? JSON.parse(renderOrderRaw) : undefined,
				spacing: JSON.parse(yMap.get("spacing") as string),
				spineSourceId: yMap.get("spineSourceId") as string | undefined,
				tiltToSpine: yMap.get("tiltToSpine") as boolean | undefined,
			} satisfies BlendObject;
		}

		case "reference3d":
			return {
				...base,
				type: "reference3d",
				sceneId: yMap.get("sceneId") as string,
				x: yMap.get("x") as number,
				y: yMap.get("y") as number,
				width: yMap.get("width") as number,
				height: yMap.get("height") as number,
				displayMode: yMap.get(
					"displayMode",
				) as Reference3DElement["displayMode"],
				camera: JSON.parse(yMap.get("camera") as string),
				lineart: yMap.has("lineart")
					? JSON.parse(yMap.get("lineart") as string)
					: undefined,
				lightDir: yMap.has("lightDir")
					? JSON.parse(yMap.get("lightDir") as string)
					: undefined,
				includeInExport: yMap.get("includeInExport") as boolean | undefined,
			} satisfies Reference3DElement;

		case "repeat":
			return {
				...base,
				type: "repeat",
				sourceIds: JSON.parse(yMap.get("sourceIds") as string),
				mode: yMap.get("mode") as RepeatObject["mode"],
				grid: JSON.parse(yMap.get("grid") as string),
				radial: JSON.parse(yMap.get("radial") as string),
				mirror: JSON.parse(yMap.get("mirror") as string),
			} satisfies RepeatObject;

		default:
			throw new Error(`Unknown element type: ${type}`);
	}
}

/**
 * Y.Doc から Document オブジェクトを抽出する。
 * YjsProvider.syncYjsToValtio() と TimelapsePlayer の両方で使用される共有ユーティリティ。
 *
 * 正規化データモデル:
 *   objects: Y.Map<Y.Map<unknown>>  -- 全 ArtObject を ID でフラットに格納
 *   layers[i].elementIds: Y.Array<string>  -- ID 参照のみ
 *
 * viewport はデフォルト値を返す（呼び出し元がローカル値で上書きする想定）。
 */
export function extractDocumentFromYDoc(ydoc: Y.Doc): Document {
	const yObjects = ydoc.getMap<Y.Map<unknown>>("objects");
	const yLayers = ydoc.getArray<Y.Map<unknown>>("layers");
	const yMeta = ydoc.getMap("meta");
	const yArtboards = ydoc.getArray<Artboard>("artboards");
	const yFiles = ydoc.getMap<SerializedEmbeddedFile>("files");
	const yBrushPresets = ydoc.getMap<Y.Map<unknown>>("brushPresets");
	const yAppearancePresets = ydoc.getMap<Y.Map<unknown>>("appearancePresets");
	const yDefs = ydoc.getMap<Y.Map<unknown>>("defs");
	const yReferences3d = ydoc.getMap<Y.Map<unknown>>("references3d");

	// objects: Y.Map<Y.Map<unknown>> → Record<string, AnyArtObject>
	const objects: Record<string, AnyArtObject> = {};
	for (const [id, yMap] of yObjects.entries()) {
		objects[id] = yMapToObject(yMap as Y.Map<unknown>);
	}

	// layers: Y.Array<Y.Map> → Layer[]
	const layers: Layer[] = [];
	for (let i = 0; i < yLayers.length; i++) {
		const yLayer = yLayers.get(i);
		if (!yLayer) continue;
		layers.push(yMapToLayer(yLayer));
	}

	// artboards
	const artboards: Artboard[] = yArtboards.toArray();

	// files: Y.Map<SerializedEmbeddedFile> → EmbeddedFile[]
	const files: EmbeddedFile[] = [];
	for (const [_uid, serialized] of yFiles.entries()) {
		files.push({
			uid: serialized.uid,
			name: serialized.name,
			type: serialized.type,
			hash: serialized.hash,
			bin: normalizeEmbeddedBin(serialized.bin),
		});
	}

	// brushPresets: Y.Map<Y.Map<unknown>> → BrushPreset[]
	const brushPresets: BrushPreset[] = [];
	for (const [_uid, yPreset] of yBrushPresets.entries()) {
		const rawSettings = yPreset.get("settings");
		brushPresets.push({
			uid: String(yPreset.get("uid")),
			name: String(yPreset.get("name")),
			settings:
				typeof rawSettings === "string" ? JSON.parse(rawSettings) : rawSettings,
		});
	}

	// appearancePresets: Y.Map<Y.Map<unknown>> → AppearancePreset[]
	const appearancePresets: AppearancePreset[] = [];
	for (const [_uid, yPreset] of yAppearancePresets.entries()) {
		const preset = yMapToAppearancePreset(yPreset);
		if (preset) appearancePresets.push(preset);
	}

	// defs: Y.Map<Y.Map<unknown>> → Record<string, DefEntry>
	const defs: Record<string, DefEntry> = {};
	for (const [defId, yDef] of yDefs.entries()) {
		const entry = yMapToDefEntry(yDef);
		if (entry) defs[defId] = entry;
	}

	// references3d: Y.Map<Y.Map<unknown>> → Record<string, Reference3DDef>
	const references3d: Record<string, Reference3DDef> = {};
	for (const [sceneId, yScene] of yReferences3d.entries()) {
		const def = yMapToReference3DDef(yScene);
		if (def) references3d[sceneId] = def;
	}

	const hdr = yMeta.has("hdr")
		? (() => {
				const parsed = safeJSONParse(String(yMeta.get("hdr") ?? ""));
				if (!parsed.ok) return { enabled: false, exposure: 0 };
				return {
					enabled:
						typeof parsed.result.enabled === "boolean"
							? parsed.result.enabled
							: false,
					exposure:
						typeof parsed.result.exposure === "number" &&
						Number.isFinite(parsed.result.exposure)
							? parsed.result.exposure
							: 0,
				};
			})()
		: { enabled: false, exposure: 0 };

	const colorProfile: ColorProfileSettings | undefined = yMeta.has(
		"colorProfile",
	)
		? (() => {
				const parsed = safeJSONParse(String(yMeta.get("colorProfile") ?? ""));
				if (!parsed.ok) return undefined;
				const { workingSpace, proofProfile, proofIntent } =
					parsed.result as ColorProfileSettings;
				if (workingSpace !== "srgb" && workingSpace !== "display-p3")
					return undefined;
				return {
					workingSpace,
					...(isValidProofProfile(proofProfile) ? { proofProfile } : {}),
					...(isValidProofIntent(proofIntent) ? { proofIntent } : {}),
				} satisfies ColorProfileSettings;
			})()
		: undefined;

	const rawRasterizationDpi = yMeta.get("rasterizationDpi");
	const rasterizationDpi =
		typeof rawRasterizationDpi === "number" &&
		Number.isFinite(rawRasterizationDpi) &&
		rawRasterizationDpi > 0
			? rawRasterizationDpi
			: 72;

	return {
		id: (yMeta.get("id") as string) ?? "",
		objects,
		layers,
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files,
		artboards,
		brushPresets,
		appearancePresets,
		hdr,
		colorProfile,
		rasterizationDpi,
		defs,
		references3d,
	};
}

/**
 * Extract only the layers array from Y.Doc.
 * Used for layer-only sync (reorder, visibility toggle, etc.)
 * to avoid re-extracting all objects.
 */
export function extractLayersFromYDoc(ydoc: Y.Doc): Layer[] {
	const yLayers = ydoc.getArray<Y.Map<unknown>>("layers");
	const layers: Layer[] = [];
	for (let i = 0; i < yLayers.length; i++) {
		const yLayer = yLayers.get(i);
		if (!yLayer) continue;
		layers.push(yMapToLayer(yLayer));
	}
	return layers;
}

function normalizeEmbeddedBin(bin: Uint8Array | number[]): Uint8Array {
	return bin instanceof Uint8Array ? bin : new Uint8Array(bin);
}

/**
 * Validate a proof rendering intent coming from untrusted remote JSON.
 * An unknown intent would crash ColorEngine's toEngineIntent (no default case).
 */
function isValidProofIntent(value: unknown): value is RenderingIntent {
	return (
		value === "perceptual" ||
		value === "relative-colorimetric" ||
		value === "saturation" ||
		value === "absolute-colorimetric"
	);
}

/**
 * Deserialize a Yjs layer entry into a Layer, including the optional
 * transient-layer fields (pattern-edit working layers).
 */
function yMapToLayer(yLayer: Y.Map<unknown>): Layer {
	const yElementIds = yLayer.get("elementIds") as Y.Array<string>;
	const elementIds: string[] = yElementIds ? yElementIds.toArray() : [];
	const transientKind = yLayer.get("transientKind");
	const ownerClientId = yLayer.get("ownerClientId");
	return {
		id: yLayer.get("id") as string,
		name: yLayer.get("name") as string,
		visible: yLayer.get("visible") as boolean,
		locked: yLayer.get("locked") as boolean,
		opacity: yLayer.get("opacity") as number,
		blendMode: (yLayer.get("blendMode") as BlendMode) ?? "normal",
		elementIds,
		// Every kind, not a hand-listed one: a kind that survives the write but
		// not the read comes back as an ordinary layer, and a working layer read
		// as ordinary puts its contents on the canvas as ordinary objects.
		...(isTransientLayerKind(transientKind) ? { transientKind } : {}),
		...(typeof ownerClientId === "string" ? { ownerClientId } : {}),
	};
}

/**
 * Deserialize a Yjs def entry. Returns null if required fields (id, kind,
 * rootElementIds) are missing or malformed.
 */
function yMapToDefEntry(yDef: Y.Map<unknown>): DefEntry | null {
	const id = yDef.get("id");
	const kind = yDef.get("kind");
	if (typeof id !== "string" || !isValidDefKind(kind)) return null;
	const yRoots = yDef.get("rootElementIds") as Y.Array<string> | undefined;
	const rootElementIds: string[] = yRoots ? yRoots.toArray() : [];
	const name = yDef.get("name");
	const tileRaw = yDef.get("tile");
	let tile: { width: number; height: number } | undefined;
	if (typeof tileRaw === "string") {
		const parsed = safeJSONParse(tileRaw);
		if (
			parsed.ok &&
			typeof parsed.result?.width === "number" &&
			typeof parsed.result?.height === "number"
		) {
			tile = { width: parsed.result.width, height: parsed.result.height };
		}
	}
	return {
		id,
		kind,
		rootElementIds,
		...(typeof name === "string" ? { name } : {}),
		...(tile ? { tile } : {}),
	};
}

function yMapToAppearancePreset(
	yPreset: Y.Map<unknown>,
): AppearancePreset | null {
	const uid = yPreset.get("uid");
	const name = yPreset.get("name");
	const rawFilters = yPreset.get("filters");
	if (typeof uid !== "string" || typeof name !== "string") return null;
	if (typeof rawFilters !== "string") return null;
	const parsed = safeJSONParse(rawFilters);
	if (!parsed.ok || !Array.isArray(parsed.result)) return null;
	return {
		uid,
		name,
		filters: normalizeAppearanceFields(parsed.result as Filter[]),
	};
}

function isValidDefKind(value: unknown): value is DefKind {
	return value === "pattern" || value === "vector-brush";
}

/**
 * Deserialize a Yjs reference3d entry (nodes stored as a JSON string). Returns
 * null if required fields are missing or the nodes JSON is malformed.
 */
function yMapToReference3DDef(yScene: Y.Map<unknown>): Reference3DDef | null {
	const id = yScene.get("id");
	const nodesRaw = yScene.get("nodes");
	if (typeof id !== "string" || typeof nodesRaw !== "string") return null;
	const parsed = safeJSONParse(nodesRaw);
	if (!parsed.ok || !Array.isArray(parsed.result)) return null;
	const name = yScene.get("name");
	return {
		id,
		nodes: parsed.result,
		...(typeof name === "string" ? { name } : {}),
	};
}

/** Validate a proof profile reference coming from untrusted remote JSON. */
function isValidProofProfile(value: unknown): value is ProofProfileRef {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Record<string, unknown>;
	if (ref.kind === "builtin")
		return ref.id === "srgb" || ref.id === "display-p3";
	if (ref.kind === "embedded") return typeof ref.fileUid === "string";
	return false;
}
