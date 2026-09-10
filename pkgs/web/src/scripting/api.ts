import type { ScriptHost } from "@paplico/syrup";
import type {
	AutomationPromptRequest,
	AutomationPromptResponse,
} from "@/automation/types";
import type {
	AnyArtObject,
	Artboard,
	ArtObject,
	BlendObject,
	BoundingBox,
	CompoundPath,
	Document,
	ElementTransform,
	Group,
	ImageObject,
	Layer,
	MeshArtObject,
	Path,
	Reference3DElement,
	TextElement,
} from "@/core/schema";
import type {
	AutomationDirectory,
	AutomationFile,
	AutomationFileSystem,
} from "@/infra/automationFileSystem";

export const PAPLICO_SCRIPTING_DECLARATIONS = `
declare type Transform {
	var x: Number
	var y: Number
	var rotation: Number
	var scaleX: Number
	var scaleY: Number
}

declare type Bounds {
	let x: Number
	let y: Number
	let minX: Number
	let minY: Number
	let maxX: Number
	let maxY: Number
	let width: Number
	let height: Number
}

declare type Point {
	let x: Number
	let y: Number
}

declare type RGBColor {
	let r: Number
	let g: Number
	let b: Number
}

declare type Filter {
	let uid: String
	let processor: String
	let enabled: Bool?
	let opacity: Number
	let blendMode: String
	let applyToBackdrop: Bool?
	let subFilters: [Filter]?
}

declare type PathSegment {
	let cp1: Point
	let cp2: Point
	let end: Point
	let startPressure: Number?
	let endPressure: Number?
	let startTiltX: Number
	let startTiltY: Number
	let endTiltX: Number
	let endTiltY: Number
	let startDeltaTime: Number
	let endDeltaTime: Number
	let isMoved: Bool
	let isClosed: Bool?
	let cornerRadius: Number?
	let cornerSuperellipseN: Number?
}

declare type StrokeWidthPoint {
	let t: Number
	let side1: Number
	let side2: Number
}

declare type EraseMask {
	let uid: String
	let segments: [PathSegment]
	let opacity: Number
}

declare type CompoundPathSource {
	let id: String
	let op: String
}

declare type BlendSpacing {
	let type: String
	let count: Number?
	let spacing: Number?
}

declare type TextContent {
	var paragraphs: [TextParagraph]
}

declare type TextParagraph {
	var runs: [TextRun]
	let alignment: String
	let lineHeight: Number
	let indent: Number
}

declare type TextRun {
	var text: String
	let style: TextStyle
}

declare type TextStyle {
	let fontFamily: String
	let fontSize: Number
	let fontWeight: Number
	let fontStyle: String
	let underline: Bool
	let strikethrough: Bool
	let letterSpacing: Number
	let lineHeight: Number?
	let baselineShift: Number
}

declare type TextLayout {
	let writingMode: String
	let boxWidth: Number
	let boxHeight: Number
	let overflow: String
	let wordWrap: Bool
}

declare type TextAxisBinding {
	let mode: String
	let pathObjectId: String
	let startOffset: Number?
	let offset: Number?
	let alignment: String?
	let offsetDistance: Number?
	let orientation: String?
	let inset: Number?
}

declare type TextFlow {
	let nextTextElementId: String?
}

declare type MeshVertex {
	let x: Number
	let y: Number
	let src: Point
	let hidden: Bool?
	let splitLineId: Number?
}

declare type MeshFace {
	let type: String
	let verts: [Number]
}

declare type Reference3DCamera {
	let projection: String
	let position: [Number]
	let target: [Number]
	let up: [Number]?
	let fovDeg: Number
	let orthoHeight: Number?
}

declare type Lineart3DParams {
	let lineWidthPx: Number
	let depthEdgeThreshold: Number
	let normalEdgeThreshold: Number
	let creaseAngleDeg: Number
}

declare type ArtObject {
	let uid: String
	let type: String
	var name: String
	var visible: Bool
	var locked: Bool
	var opacity: Number
	var blendMode: String
	var compositionMode: String?
	let filters: [Filter]?
	let transform: Transform
	let bounds: Bounds
	let segments: [PathSegment]?
	let isGuide: Bool?
	let pathStart: Number?
	let pathEnd: Number?
	let strokeWidths: [StrokeWidthPoint]?
	let eraseMasks: [EraseMask]?
	let childIds: [String]?
	let collapsed: Bool?
	let clipPathId: String?
	let sources: [CompoundPathSource]?
	let objectIds: [String]?
	let renderOrder: [String]?
	let spacing: BlendSpacing?
	let spineSourceId: String?
	let tiltToSpine: Bool?
	let fileUid: String?
	let x: Number?
	let y: Number?
	let width: Number?
	let height: Number?
	let content: TextContent?
	let defaultStyle: TextStyle?
	let layout: TextLayout?
	let axisBinding: TextAxisBinding?
	let flow: TextFlow?
	let vertices: [MeshVertex]?
	let faces: [MeshFace]?
	let sceneId: String?
	let camera: Reference3DCamera?
	let displayMode: String?
	let lineart: Lineart3DParams?
	let lightDir: [Number]?
	let includeInExport: Bool?
}

declare type Layer {
	let uid: String
	var name: String
	var visible: Bool
	var locked: Bool
	var opacity: Number
	var blendMode: String
	let elementIds: [String]
	let transientKind: String?
	let ownerClientId: String?
	fn artObjects() -> [ArtObject]
}

declare type Artboard {
	let uid: String
	var name: String
	var x: Number
	var y: Number
	var width: Number
	var height: Number
	var backgroundColor: RGBColor?
}

declare type Viewport {
	let x: Number
	let y: Number
	let zoom: Number
	let rotation: Number
}

declare type HdrSettings {
	let enabled: Bool
	let exposure: Number
}

declare type ColorProfileSettings {
	let workingSpace: String
	let proofIntent: String?
}

declare type Document {
	let uid: String
	let title: String
	let viewport: Viewport
	let schemaVersion: Number?
	var hdr: HdrSettings?
	var colorProfile: ColorProfileSettings?
	var rasterizationDpi: Number?
	fn findArtObject(uid: String) -> ArtObject?
	fn artObjects() -> [ArtObject]
	fn findLayer(uid: String) -> Layer?
	fn layers() -> [Layer]
	fn findArtboard(uid: String) -> Artboard?
	fn artboards() -> [Artboard]
}

declare type Editor {
	let selection: [ArtObject]
	fn select(uids: [String]) -> Void
	fn clearSelection() -> Void
}

declare type AutomationFile {
	let name: String
	async fn readText() -> String
	async fn readBytes() -> [Number]
	async fn writeText(content: String) -> Void
	async fn writeBytes(content: [Number]) -> Void
}

declare type DocumentDirectory {
	async fn file(path: String, create?: Bool) -> AutomationFile?
	async fn createDirectory(path: String) -> DocumentDirectory
}

declare type FileSystem {
	let documentDirectory: DocumentDirectory?
	async fn openFiles() -> [AutomationFile]
	async fn saveFile(fileName?: String, extensions?: [String]) -> AutomationFile?
}

declare type Prompt {
	async fn alert(message: String) -> Void
	async fn confirm(message: String) -> Bool
	async fn string(message: String, defaultValue?: String?) -> String?
	async fn number(message: String, defaultValue?: Number?) -> Number?
	async fn boolean(message: String, defaultValue?: Bool?) -> Bool?
	async fn choice(message: String, choices: [String], defaultValue?: String?) -> String?
}

declare let activeDocument: Document
declare let editor: Editor
declare let prompt: Prompt
declare fn getFileSystem() -> FileSystem?
`;

export interface ScriptArtObject
	extends Omit<ArtObject, "id" | "name" | "visible" | "locked" | "transform"> {
	readonly uid: string;
	readonly type: AnyArtObject["type"];
	name: string;
	visible: boolean;
	locked: boolean;
	readonly transform: ScriptTransform;
	readonly bounds: BoundingBox & { readonly x: number; readonly y: number };
	readonly segments?: Path["segments"];
	readonly isGuide?: Path["isGuide"];
	readonly pathStart?: Path["pathStart"];
	readonly pathEnd?: Path["pathEnd"];
	readonly strokeWidths?: Path["strokeWidths"];
	readonly eraseMasks?: Path["eraseMasks"];
	readonly childIds?: Group["childIds"] | MeshArtObject["childIds"];
	readonly collapsed?: Group["collapsed"];
	readonly clipPathId?: Group["clipPathId"] | TextElement["clipPathId"];
	readonly sources?: CompoundPath["sources"];
	readonly objectIds?: BlendObject["objectIds"];
	readonly renderOrder?: BlendObject["renderOrder"];
	readonly spacing?: BlendObject["spacing"];
	readonly spineSourceId?: BlendObject["spineSourceId"];
	readonly tiltToSpine?: BlendObject["tiltToSpine"];
	readonly fileUid?: ImageObject["fileUid"];
	readonly x?: ImageObject["x"] | TextElement["x"] | Reference3DElement["x"];
	readonly y?: ImageObject["y"] | TextElement["y"] | Reference3DElement["y"];
	readonly width?: ImageObject["width"];
	readonly height?: ImageObject["height"];
	readonly content?: TextElement["content"];
	readonly defaultStyle?: TextElement["defaultStyle"];
	readonly layout?: TextElement["layout"];
	readonly axisBinding?: TextElement["axisBinding"];
	readonly flow?: TextElement["flow"];
	readonly vertices?: MeshArtObject["vertices"];
	readonly faces?: MeshArtObject["faces"];
	readonly sceneId?: Reference3DElement["sceneId"];
	readonly camera?: Reference3DElement["camera"];
	readonly displayMode?: Reference3DElement["displayMode"];
	readonly lineart?: Reference3DElement["lineart"];
	readonly lightDir?: Reference3DElement["lightDir"];
	readonly includeInExport?: Reference3DElement["includeInExport"];
}

export type ScriptTransform = ElementTransform;

export interface ScriptLayer extends Omit<Layer, "id"> {
	readonly uid: string;
	artObjects(): ScriptArtObject[];
}

export interface ScriptArtboard extends Omit<Artboard, "id"> {
	readonly uid: string;
}

export interface ScriptDocument {
	readonly uid: string;
	readonly title: string;
	readonly viewport: Document["viewport"];
	readonly schemaVersion: Document["schemaVersion"];
	hdr: Document["hdr"];
	colorProfile: Document["colorProfile"];
	rasterizationDpi: Document["rasterizationDpi"];
	findArtObject(uid: string): ScriptArtObject | null | undefined;
	artObjects(): ScriptArtObject[];
	findLayer(uid: string): ScriptLayer | null | undefined;
	layers(): ScriptLayer[];
	findArtboard(uid: string): ScriptArtboard | null | undefined;
	artboards(): ScriptArtboard[];
}

export interface ScriptEditor {
	readonly selection: ScriptArtObject[];
	select(uids: string[]): void;
	clearSelection(): void;
}

export type ScriptAutomationFile = AutomationFile;
export type ScriptDocumentDirectory = AutomationDirectory;
export type ScriptFileSystem = AutomationFileSystem;

export interface ScriptPrompt {
	alert(message: string): Promise<void>;
	confirm(message: string): Promise<boolean>;
	string(message: string, defaultValue?: string): Promise<string | null>;
	number(message: string, defaultValue?: number): Promise<number | null>;
	boolean(message: string, defaultValue?: boolean): Promise<boolean | null>;
	choice(
		message: string,
		choices: string[],
		defaultValue?: string,
	): Promise<string | null>;
}

export interface PaplicoScriptingBridge {
	getActiveDocument(): ScriptDocument;
	getEditor?(): ScriptEditor;
	getFileSystem?(): ScriptFileSystem | null;
}

export function registerPaplicoScriptingApi(
	host: ScriptHost,
	bridge: PaplicoScriptingBridge = LANGUAGE_SERVICE_BRIDGE,
	prompt: ScriptPrompt = EMPTY_PROMPT,
): void {
	host.registerPackage({
		name: "paplico",
		declarations: PAPLICO_SCRIPTING_DECLARATIONS,
		runtime: {
			get activeDocument(): ScriptDocument {
				return bridge.getActiveDocument();
			},
			get editor(): ScriptEditor {
				return bridge.getEditor?.() ?? EMPTY_EDITOR;
			},
			prompt,
			getFileSystem: (): ScriptFileSystem | null =>
				bridge.getFileSystem?.() ?? null,
		},
	});
}

const EMPTY_DOCUMENT: ScriptDocument = {
	uid: "",
	title: "",
	viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
	schemaVersion: undefined,
	hdr: undefined,
	colorProfile: undefined,
	rasterizationDpi: undefined,
	findArtObject: () => null,
	artObjects: () => [],
	findLayer: () => null,
	layers: () => [],
	findArtboard: () => null,
	artboards: () => [],
};

const LANGUAGE_SERVICE_BRIDGE: PaplicoScriptingBridge = {
	getActiveDocument: () => EMPTY_DOCUMENT,
};

const EMPTY_EDITOR: ScriptEditor = {
	selection: [],
	select: () => {},
	clearSelection: () => {},
};

export function createScriptPrompt(
	handlePrompt: (
		request: AutomationPromptRequest,
	) => Promise<AutomationPromptResponse>,
): ScriptPrompt {
	return {
		alert: async (message) => {
			await handlePrompt({ kind: "alert", message });
		},
		confirm: async (message) => {
			const response = await handlePrompt({ kind: "confirm", message });
			return typeof response === "boolean" ? response : false;
		},
		string: async (message, defaultValue = "") => {
			const response = await handlePrompt({
				kind: "string",
				message,
				defaultValue,
			});
			return typeof response === "string" ? response : null;
		},
		number: async (message, defaultValue = 0) => {
			const response = await handlePrompt({
				kind: "number",
				message,
				defaultValue,
			});
			return typeof response === "number" ? response : null;
		},
		boolean: async (message, defaultValue = true) => {
			const response = await handlePrompt({
				kind: "boolean",
				message,
				defaultValue,
			});
			return typeof response === "boolean" ? response : null;
		},
		choice: async (message, choices, defaultValue = "") => {
			const response = await handlePrompt({
				kind: "choice",
				message,
				choices,
				defaultValue,
			});
			return typeof response === "string" && choices.includes(response)
				? response
				: null;
		},
	};
}

const EMPTY_PROMPT = createScriptPrompt(async () => null);
