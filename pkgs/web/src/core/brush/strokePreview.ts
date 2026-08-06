import {
	createDefaultDocument,
	createIdentityTransform,
} from "../document/factory";
import type {
	BrushSettingsV2,
	Color,
	Document,
	EmbeddedFile,
	Path,
	PathSegment,
	RawRGBA,
	StrokeAppearance,
} from "../schema";
import { calculateElementBounds, expandBounds } from "../utils/geometry/bounds";
import { deepClone } from "../utils/lang";
import { readStoredBrushSize, readStoredWetBleedRatio } from "./access";

export interface BrushStrokePreviewOptions {
	brushSettings: BrushSettingsV2 | BrushSettingsV2;
	textureFile: EmbeddedFile | null;
	segments: PathSegment[];
	width: number;
	height: number;
	strokeColor?: Color;
	backgroundColor?: RawRGBA;
}

export interface BrushStrokePreviewScene {
	document: Document;
	pathId: string;
	bounds: {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
	};
	scale: number;
	backgroundColor: RawRGBA;
}

const DEFAULT_BACKGROUND_COLOR: RawRGBA = { r: 0, g: 0, b: 0, a: 0 };
const DEFAULT_STROKE_COLOR: Color = { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
const PREVIEW_DOCUMENT_ID = "brush-preview-document";
const PREVIEW_PATH_ID = "brush-preview-path";

export function createBrushStrokePreviewScene(
	options: BrushStrokePreviewOptions,
): BrushStrokePreviewScene {
	const path = createBrushStrokePreviewPath(
		options.segments,
		options.brushSettings,
		options.strokeColor ?? DEFAULT_STROKE_COLOR,
	);
	const document = createDefaultDocument(PREVIEW_DOCUMENT_ID);
	document.layers[0].elementIds = [path.id];
	document.objects[path.id] = path;

	if (options.textureFile) {
		document.files = [
			{
				...options.textureFile,
				bin: new Uint8Array(options.textureFile.bin),
			},
		];
	}

	const size = readStoredBrushSize(options.brushSettings) ?? 0;
	const bleedRatio = readStoredWetBleedRatio(options.brushSettings);
	const wetBleed = bleedRatio > 0 ? size * (0.5 + bleedRatio) : 0;
	const pathBounds = expandBounds(
		calculateElementBounds(path),
		Math.max(size * 0.75, wetBleed, 8),
	);
	const scale = Math.min(
		options.width / pathBounds.width,
		options.height / pathBounds.height,
	);

	return {
		document,
		pathId: path.id,
		bounds: {
			centerX: (pathBounds.minX + pathBounds.maxX) / 2,
			centerY: (pathBounds.minY + pathBounds.maxY) / 2,
			width: pathBounds.width,
			height: pathBounds.height,
		},
		scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
		backgroundColor: options.backgroundColor ?? DEFAULT_BACKGROUND_COLOR,
	};
}

export function createBrushStrokePreviewPath(
	segments: PathSegment[],
	brushSettings: BrushSettingsV2 | BrushSettingsV2,
	strokeColor: Color,
): Path {
	return {
		type: "path",
		id: PREVIEW_PATH_ID,
		transform: createIdentityTransform(),
		opacity: 1,
		blendMode: "normal",
		segments,
		filters: [
			{
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: { type: "solid", color: strokeColor },
						brushSettings: deepClone(brushSettings),
					},
				},
			} as StrokeAppearance,
		],
	};
}
