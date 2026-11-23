/**
 * TextLayoutEngine
 * テキストのレイアウト計算を担当
 * - 水平/垂直書き
 * - 行折り返し（boxWidth/wordWrap、禁則処理付き）
 * - ボックス制約とオーバーフロー判定（hidden/ellipsis/visible）
 * - クローズパス内部への流し込み（inShape、スキャンライン）
 * - 文字単位のカーニング調整
 * - パス上配置（パス全長での打ち切り付き）
 * - 複数リージョンへの流し込み（layoutFlow）
 *
 * レイアウトは shape → break → place の3相:
 * shape はスタイル解決とグリフ整形、break は TextLineWidthProvider の
 * 利用可能区間に対する貪欲な行分割、place は行内座標の確定を行う。
 */

import type {
	BoundingBox,
	CharOverride,
	CubicBezierSegment,
	Point,
	TextContent,
	TextElement,
	TextLayout,
	TextOnPathBinding,
	TextParagraph,
	TextStyle,
} from "../schema";
import {
	buildArcLengthTable,
	samplePathAtArcLength,
} from "../utils/geometry/measure/arcLength";
import { resolveSegment } from "../utils/geometry/primitives/segment";
import { translateSegments } from "../utils/geometry/space/worldSegments";
import type { GlyphColorLayer } from "./fonts/colorGlyphs";
import type { LoadedFont } from "./fonts/FontLoader";
import type { FontManager } from "./fonts/FontManager";
import { rotateAnchorAroundPivot } from "./glyphQuad";
import { canBreakBetween } from "./lineBreak";
import {
	flattenClosedSubpaths,
	intervalsForBand,
	type TextLineInterval,
} from "./regionGeometry";
import { isUprightInVertical } from "./verticalOrientation";

/**
 * レイアウト済み文字情報
 */
export interface LayoutedChar {
	char: string;
	charIndex: number; // コンテンツ内の文字インデックス
	runIndex: number; // 所属するRun
	paragraphIndex: number; // 所属するParagraph
	x: number; // ワールド座標X
	y: number; // ワールド座標Y
	rotation: number; // 文字の回転（ラジアン）、パス配置時に使用
	fontSize: number;
	font: LoadedFont;
	glyphPath: CubicBezierSegment[];
	/** Colored layers of a color glyph, splitting `glyphPath` bottom layer first. */
	colorLayers?: readonly GlyphColorLayer[];
	advanceWidth: number;
	kerningOffset: number; // カーニング調整値
	sizeScale: number; // 文字サイズスケール（CharOverrideから）
	override?: CharOverride;
	/** 縦書き中の横組み（縦中横）セル内のグリフ。キャレット/ヒットは横書き扱い */
	tateChuYoko?: boolean;
	/**
	 * Laid on its side in a vertical column. `y` is then the top of the glyph's
	 * cell instead of its baseline, and the cell runs down by `advanceWidth`.
	 */
	sideways?: boolean;
	/** ellipsis等、コンテンツに存在しない合成グリフ（カーソル/ヒット対象外） */
	synthetic?: boolean;
	/** このグリフが消費するコンテンツ文字数（合字>1、省略時1） */
	charLength?: number;
}

/**
 * レイアウト済み行情報
 */
export interface LayoutedLine {
	chars: LayoutedChar[];
	width: number;
	height: number;
	baseline: number;
	x: number;
	y: number;
	/** 所属するParagraph（折り返しで1段落が複数行になる） */
	paragraphIndex: number;
	/** 前の行からの折り返し行（行頭が改行由来でない）なら true */
	softWrapped: boolean;
}

/**
 * レイアウト結果
 */
export interface LayoutResult {
	lines: LayoutedLine[];
	bounds: BoundingBox;
	chars: LayoutedChar[]; // フラットな文字配列
	/** リージョン/パスに収まらなかった文字があるか */
	hasOverflow: boolean;
	/** 収まらなかった最初の文字の content-global charIndex */
	overflowStartIndex?: number;
}

/**
 * axisBinding参照の解決済みジオメトリ（要素ローカル座標）
 * pathObjectIdからの解決は呼び出し側（TextRenderer）が行う
 */
export interface ResolvedTextRegionGeometry {
	kind: "onPath" | "inShape";
	segments: CubicBezierSegment[];
}

/**
 * layoutFlow の流し込み先リージョン指定
 */
interface TextFlowRegion {
	element: TextElement;
	geometry?: ResolvedTextRegionGeometry;
}

/**
 * 行バンドごとの利用可能水平区間を返す抽象。
 * null はリージョン終端（以降の文字はオーバーフロー）を表す。
 */
interface TextLineWidthProvider {
	intervalsForLine(yTop: number, yBottom: number): TextLineInterval[] | null;
}

/** 行分割の対象となる整形済み文字 */
interface ShapedCharItem {
	kind: "char";
	char: string;
	rawGlyphPath: CubicBezierSegment[];
	colorLayers?: readonly GlyphColorLayer[];
	advanceWidth: number; // sizeScale適用済み
	kerning: number;
	/** Per-run tracking (letterSpacing × fontSize) applied after each char */
	letterSpacingPx: number;
	sizeScale: number;
	fontSize: number;
	font: LoadedFont;
	runIndex: number;
	paragraphIndex: number;
	charIndex: number; // content-global
	/** このグリフが消費するコンテンツ文字数（合字>1） */
	charLength: number;
	/** Leading (px) from this char's run style. Line advance = max within the line */
	lineHeightPx: number;
	/** Inline-footprint delta of a touch-rotated glyph (horizontal/on-path advance) */
	advanceAdjustPx: number;
	/** Same footprint delta projected on the vertical flow axis */
	verticalAdvanceAdjustPx: number;
	/** 縦中横: consecutive flagged chars compose horizontally in one cell */
	tateChuYoko?: boolean;
	/** Laid on its side in vertical writing, advancing by its width */
	sideways?: boolean;
	override?: CharOverride;
}

/** 段落区切り（改行1文字ぶんのcharIndexを消費する） */
interface ParaBreakItem {
	kind: "break";
	/** この区切りが開く段落のインデックス */
	paragraphIndex: number;
	charIndex: number;
}

type StreamItem = ShapedCharItem | ParaBreakItem;

interface ParaMeta {
	alignment: TextParagraph["alignment"];
	maxLineHeight: number;
	/** 段落内の最大フォントサイズ（インクバンド=ascent/descent の評価用） */
	maxFontSize: number;
}

interface ShapedStream {
	stream: StreamItem[];
	paraMeta: ParaMeta[];
}

/** 流し込みの継続位置（複数リージョンチェーン用） */
interface FlowCursor {
	/** 次に配置する段落インデックス */
	p: number;
	/** 次に配置する stream インデックス */
	idx: number;
	/** 段落の途中からの継続（先頭行を softWrapped にする） */
	mid: boolean;
}

interface RegionSpec {
	/** null = 制約なし（段落=1行、原点基準アラインメント） */
	provider: TextLineWidthProvider | null;
	/** 最初の行バンドの上端Y（要素ローカル） */
	startTop: number;
	/**
	 * Whether the first line's em box, not its line height, starts at
	 * `startTop`, so the leading above it does not take a shape's top edge.
	 */
	firstLineAtEmBox: boolean;
	ellipsis: boolean;
	/** リージョン自体の外形bounds（空リージョンでも選択可能にするための下限bounds） */
	regionBounds: BoundingBox | null;
}

/** 縦書き用: 列のXバンドに対する利用可能なY区間（{x0:下端, x1:上端}） */
interface VerticalColumnProvider {
	intervalsForColumn(xLeft: number, xRight: number): TextLineInterval[] | null;
}

interface VerticalRegionSpec {
	provider: VerticalColumnProvider | null;
	/** 最初の列の右端X（要素ローカル） */
	startRight: number;
	ellipsis: boolean;
	regionBounds: BoundingBox | null;
	/** Where a column is aligned when the interval it fills has no bottom. */
	alignWithin?: TextLineInterval;
}

interface PlacedLine {
	line: LayoutedLine;
	x0: number;
	x1: number;
}

interface RegionFlowResult {
	placed: PlacedLine[];
	chars: LayoutedChar[];
	/** 未配置分の継続位置。null = 全て配置済み */
	next: FlowCursor | null;
	overflowStartIndex?: number;
}

const EPS = 1e-6;
const BASELINE_RATIO = 0.8;

/**
 * TextLayoutEngine
 */
export class TextLayoutEngine {
	private fontManager: FontManager;

	public constructor(fontManager: FontManager) {
		this.fontManager = fontManager;
	}

	/**
	 * TextElementをレイアウト
	 */
	public async layout(
		element: TextElement,
		geometry?: ResolvedTextRegionGeometry,
	): Promise<LayoutResult> {
		const { content, defaultStyle, layout, axisBinding } = element;

		// フォントをプリロード
		await this.preloadFonts(content, defaultStyle);

		// パス配置の場合
		if (axisBinding?.mode === "onPath") {
			return this.layoutOnPath(
				element,
				axisBinding,
				geometry?.kind === "onPath" ? geometry.segments : [],
			);
		}

		// 通常レイアウト（inShapeは各コアが geometry から制約を構築する）
		if (layout.writingMode === "vertical-rl") {
			return this.layoutVerticalRegionOrPlain(element, geometry);
		}
		return this.layoutHorizontal(element, geometry);
	}

	/**
	 * 縦書き: リージョン制約（box/inShape）があれば列ベースのフローコアで、
	 * 無制約なら layoutVertical でレイアウトする
	 */
	private async layoutVerticalRegionOrPlain(
		element: TextElement,
		geometry?: ResolvedTextRegionGeometry,
	): Promise<LayoutResult> {
		const spec = this.buildVerticalRegionSpec(element, geometry);
		if (!spec.provider) {
			return this.layoutVertical(element);
		}
		const shaped = await this.shapeContent(
			element.content,
			element.defaultStyle,
		);
		const flow = this.flowIntoRegionVertical(
			shaped,
			{ p: 0, idx: 0, mid: false },
			spec,
		);
		return this.finalizeRegionResult(flow, spec);
	}

	/**
	 * 先頭リージョンのcontentをチェーン全リージョンへ流し込む。
	 * 返り値は各リージョン要素IDごとの（そのリージョンのローカル座標系の）LayoutResult。
	 */
	public async layoutFlow(
		head: TextElement,
		regions: TextFlowRegion[],
	): Promise<Map<string, LayoutResult>> {
		const results = new Map<string, LayoutResult>();
		await this.preloadFonts(head.content, head.defaultStyle);
		const shaped = await this.shapeContent(head.content, head.defaultStyle);

		let cursor: FlowCursor | null = { p: 0, idx: 0, mid: false };
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			const isLast = i === regions.length - 1;
			const isVertical = region.element.layout.writingMode !== "horizontal-tb";
			const spec = this.buildRegionSpec(region.element, region.geometry);

			if (cursor === null) {
				results.set(region.element.id, {
					lines: [],
					chars: [],
					bounds: spec.regionBounds ?? EMPTY_BOUNDS,
					hasOverflow: false,
				});
				continue;
			}

			// 縦書きリージョン: 列ベースのフローコアで流し込む
			if (isVertical && region.element.axisBinding?.mode !== "onPath") {
				const vspec = this.buildVerticalRegionSpec(
					region.element,
					region.geometry,
				);
				const effectiveVspec: VerticalRegionSpec = vspec.provider
					? vspec
					: {
							// 無制約の縦書き: 高さ無限の単一列として残りを流し込む
							provider: {
								intervalsForColumn: () => [
									{ x0: Number.NEGATIVE_INFINITY, x1: 0 },
								],
							},
							startRight: 0,
							ellipsis: false,
							regionBounds: vspec.regionBounds,
							alignWithin: columnSpanOf(region.element.layout),
						};
				const flow = this.flowIntoRegionVertical(
					shaped,
					cursor,
					effectiveVspec,
				);
				results.set(
					region.element.id,
					this.finalizeRegionResult(flow, effectiveVspec),
				);
				cursor = flow.next;
				continue;
			}

			if (region.element.axisBinding?.mode === "onPath") {
				const segments =
					region.geometry?.kind === "onPath" ? region.geometry.segments : [];
				const flow = this.flowOntoPath(
					shaped,
					cursor,
					region.element.axisBinding,
					segments,
					region.element.layout.writingMode === "vertical-rl",
				);
				results.set(region.element.id, {
					lines: [],
					chars: flow.chars,
					bounds: this.calculateBounds(flow.chars),
					hasOverflow: flow.next !== null,
					overflowStartIndex: flow.overflowStartIndex,
				});
				cursor = flow.next;
				continue;
			}

			const flow = this.flowIntoRegion(shaped, cursor, spec);
			if (isLast && spec.ellipsis && flow.next) {
				await this.applyEllipsis(flow, shaped);
			}
			results.set(region.element.id, this.finalizeRegionResult(flow, spec));
			cursor = flow.next;
		}

		return results;
	}

	/**
	 * 必要なフォントをプリロード
	 */
	private async preloadFonts(
		content: TextContent,
		defaultStyle: TextStyle,
	): Promise<void> {
		// loadFont dedupes in-flight/cached loads internally
		// (GoogleFontsLoader.loadingPromises), so a reference-level Set is enough
		// here — no JSON value-key round-trip needed.
		const sources = new Set([defaultStyle.fontSource]);
		for (const para of content.paragraphs) {
			for (const run of para.runs) {
				if (run.style?.fontSource) sources.add(run.style.fontSource);
			}
		}

		// Individual failures (e.g. a nonexistent font-family) must not abort the
		// whole layout — getRunFont draws the run with the fallback font.
		await Promise.all(
			[...sources].map((source) =>
				this.fontManager.loadFont(source).catch((err) => {
					console.warn("[TextLayoutEngine] Font preload failed:", source, err);
					return null;
				}),
			),
		);
	}

	/**
	 * The font a run is drawn with. A font that could not be loaded is drawn
	 * with the built-in fallback font, while the run's style keeps naming it.
	 */
	private async getRunFont(runStyle: TextStyle): Promise<LoadedFont> {
		const font =
			this.fontManager.getLoadedFont(runStyle.fontSource) ??
			(await this.fontManager.getFallbackFont());
		return this.fontManager.resolveFontForStyle(font, runStyle);
	}

	/**
	 * shape相: 全段落の全Runを整形し、段落区切りマーカー入りのフラットな
	 * ストリームと段落メタ情報を作る
	 */
	private async shapeContent(
		content: TextContent,
		defaultStyle: TextStyle,
	): Promise<ShapedStream> {
		const stream: StreamItem[] = [];
		const paraMeta: ParaMeta[] = [];
		let globalCharIndex = 0;

		for (let pIdx = 0; pIdx < content.paragraphs.length; pIdx++) {
			const para = content.paragraphs[pIdx];

			// 段落間の改行分をglobalCharIndexに加算（TextToolのgetCursorCharIndexと一致させる）
			if (pIdx > 0) {
				stream.push({
					kind: "break",
					paragraphIndex: pIdx,
					charIndex: globalCharIndex,
				});
				globalCharIndex++;
			}

			let maxLineHeight = 0;
			let maxFontSize = 0;

			for (let rIdx = 0; rIdx < para.runs.length; rIdx++) {
				const run = para.runs[rIdx];
				const runStyle = this.mergeStyles(defaultStyle, run.style);
				const font = await this.getRunFont(runStyle);
				const fontSize = runStyle.fontSize;

				// 行の高さを更新（グリフの有無に関わらずRunごとに反映する）
				const runLineHeight =
					fontSize * (runStyle.lineHeight ?? defaultStyle.lineHeight ?? 1.5);
				maxLineHeight = Math.max(maxLineHeight, runLineHeight);
				maxFontSize = Math.max(maxFontSize, fontSize);

				const shaped = await this.fontManager.shapeText(
					font,
					run.text,
					fontSize,
					{ letterSpacing: runStyle.letterSpacing },
				);

				// Tracking is shaped into glyph x positions by shapeText, but the
				// break/place phases advance by per-item metrics — carry it there
				const letterSpacingPx = (runStyle.letterSpacing ?? 0) * fontSize;

				// Content-based indexing: ligatures merge chars (glyph count <
				// char count) and stripped control chars still occupy indices,
				// so glyph-sequential numbering desyncs caret/insertion
				const runStart = globalCharIndex;
				for (const glyph of shaped) {
					// Run内のcharOverridesから読む（run-localインデックス）
					const charOverride = run.charOverrides?.find(
						(o) => o.charIndex === glyph.charIndex,
					);

					// カーニング調整（em単位 → px変換）
					const kerningEm = charOverride?.kerningAdjust ?? 0;
					const sizeScale = charOverride?.sizeMultiplier ?? 1;
					const scale = glyphScale(sizeScale, charOverride);

					// Touch-type rotation widens/narrows the glyph's footprint on
					// the line: advance by the rotated em-box projection so the
					// gaps to both neighbours follow the rotation
					const rotRad = ((charOverride?.rotation ?? 0) * Math.PI) / 180;
					let advanceAdjustPx = 0;
					let verticalAdvanceAdjustPx = 0;
					const sideways = isSidewaysInVertical(runStyle, glyph.char);
					// A glyph on its side runs its width down the column
					const widthScale = sideways ? scale.y : scale.x;
					if (sideways) {
						verticalAdvanceAdjustPx = (glyph.advanceWidth - fontSize) * scale.y;
					} else if (rotRad !== 0) {
						const w = glyph.advanceWidth * scale.x;
						const h = fontSize * scale.y;
						const cos = Math.abs(Math.cos(rotRad));
						const sin = Math.abs(Math.sin(rotRad));
						advanceAdjustPx = w * cos + h * sin - w;
						verticalAdvanceAdjustPx = h * cos + w * sin - h;
					}

					stream.push({
						kind: "char",
						char: glyph.char,
						rawGlyphPath: glyph.path,
						colorLayers: glyph.colorLayers,
						advanceWidth: glyph.advanceWidth * widthScale,
						kerning: kerningEm * fontSize,
						letterSpacingPx,
						advanceAdjustPx,
						verticalAdvanceAdjustPx,
						sizeScale,
						fontSize,
						font,
						runIndex: rIdx,
						paragraphIndex: pIdx,
						charIndex: runStart + glyph.charIndex,
						charLength: glyph.charLength ?? 1,
						lineHeightPx: runLineHeight,
						tateChuYoko: runStyle.tateChuYoko,
						sideways,
						override: charOverride,
					});
				}
				globalCharIndex = runStart + run.text.length;
			}

			// 空段落の場合のデフォルト行高さを計算
			if (maxLineHeight === 0) {
				const firstRunStyle = this.mergeStyles(
					defaultStyle,
					para.runs[0]?.style,
				);
				maxLineHeight =
					firstRunStyle.fontSize *
					(firstRunStyle.lineHeight ?? defaultStyle.lineHeight ?? 1.5);
				maxFontSize = firstRunStyle.fontSize;
			}

			paraMeta.push({ alignment: para.alignment, maxLineHeight, maxFontSize });
		}

		return { stream, paraMeta };
	}

	/**
	 * 要素のlayout/axisBindingからリージョン制約を構築
	 */
	private buildRegionSpec(
		element: TextElement,
		geometry?: ResolvedTextRegionGeometry,
	): RegionSpec {
		const { layout, axisBinding } = element;

		if (
			axisBinding?.mode === "inShape" &&
			geometry?.kind === "inShape" &&
			geometry.segments.length > 0
		) {
			const polygons = flattenClosedSubpaths(geometry.segments);
			const inset = axisBinding.inset ?? 0;
			const shapeBounds = polygonBounds(polygons);
			if (polygons.length === 0 || shapeBounds === null) {
				return {
					provider: null,
					startTop: 0,
					firstLineAtEmBox: false,
					ellipsis: false,
					regionBounds: null,
				};
			}
			return {
				provider: {
					intervalsForLine: (top, bottom) =>
						bottom < shapeBounds.minY - EPS
							? null
							: intervalsForBand(polygons, top, bottom, inset),
				},
				startTop: shapeBounds.maxY,
				firstLineAtEmBox: true,
				ellipsis: layout.overflow === "ellipsis",
				regionBounds: shapeBounds,
			};
		}

		const boxWidth = layout.boxWidth;
		const boxHeight = layout.boxHeight;
		const hasBox = boxWidth !== "auto" || boxHeight !== "auto";
		const constrained = hasBox && layout.overflow !== "visible";

		if (constrained) {
			// wordWrap無効時は幅制約なし（boxHeightのみ行数を制限する）
			const width =
				layout.wordWrap && boxWidth !== "auto"
					? boxWidth
					: Number.POSITIVE_INFINITY;
			return {
				provider: {
					intervalsForLine: (_top, bottom) =>
						boxHeight !== "auto" && bottom < -boxHeight - EPS
							? null
							: [{ x0: 0, x1: width }],
				},
				startTop: 0,
				firstLineAtEmBox: false,
				ellipsis: layout.overflow === "ellipsis",
				regionBounds: boxRegionBounds(boxWidth, boxHeight),
			};
		}

		return {
			provider: null,
			startTop: 0,
			firstLineAtEmBox: false,
			ellipsis: false,
			regionBounds: hasBox ? boxRegionBounds(boxWidth, boxHeight) : null,
		};
	}

	/**
	 * 縦書き用のリージョン制約を構築。列はXバンドで評価し（inShapeは転置した
	 * 多角形への水平スキャンライン）、列内のY区間を返す
	 */
	private buildVerticalRegionSpec(
		element: TextElement,
		geometry?: ResolvedTextRegionGeometry,
	): VerticalRegionSpec {
		const { layout, axisBinding } = element;

		if (
			axisBinding?.mode === "inShape" &&
			geometry?.kind === "inShape" &&
			geometry.segments.length > 0
		) {
			const polygons = flattenClosedSubpaths(geometry.segments);
			const inset = axisBinding.inset ?? 0;
			const shapeBounds = polygonBounds(polygons);
			if (polygons.length === 0 || shapeBounds === null) {
				return {
					provider: null,
					startRight: 0,
					ellipsis: false,
					regionBounds: null,
				};
			}
			// 転置多角形への水平バンド走査 = 元座標での縦列バンド走査
			const transposed = polygons.map((polygon) =>
				polygon.map((pt) => ({ x: pt.y, y: pt.x })),
			);
			return {
				provider: {
					intervalsForColumn: (left, right) =>
						right < shapeBounds.minX - EPS
							? null
							: intervalsForBand(transposed, left, right, inset),
				},
				startRight: shapeBounds.maxX,
				ellipsis: false,
				regionBounds: shapeBounds,
			};
		}

		const boxWidth = layout.boxWidth;
		const boxHeight = layout.boxHeight;
		const hasBox = boxWidth !== "auto" || boxHeight !== "auto";
		const constrained = hasBox && layout.overflow !== "visible";

		if (constrained) {
			// wordWrap無効時は列の高さ制約なし（boxWidthのみ列数を制限する）
			const height =
				layout.wordWrap && boxHeight !== "auto"
					? boxHeight
					: Number.POSITIVE_INFINITY;
			return {
				provider: {
					intervalsForColumn: (left, _right) =>
						boxWidth !== "auto" && left < -EPS
							? null
							: [
									{
										x0: Number.isFinite(height)
											? -height
											: Number.NEGATIVE_INFINITY,
										x1: 0,
									},
								],
				},
				startRight: boxWidth === "auto" ? 0 : boxWidth,
				ellipsis: false,
				regionBounds: boxRegionBounds(boxWidth, boxHeight),
				alignWithin: columnSpanOf(layout),
			};
		}

		return {
			provider: null,
			startRight: 0,
			ellipsis: false,
			regionBounds: hasBox ? boxRegionBounds(boxWidth, boxHeight) : null,
		};
	}

	/**
	 * 水平書きレイアウト
	 */
	private async layoutHorizontal(
		element: TextElement,
		geometry?: ResolvedTextRegionGeometry,
	): Promise<LayoutResult> {
		const { content, defaultStyle, layout } = element;
		const shaped = await this.shapeContent(content, defaultStyle);
		const spec = this.buildRegionSpec(element, geometry);

		const flow = this.flowIntoRegion(
			shaped,
			{ p: 0, idx: 0, mid: false },
			spec,
		);
		if (spec.ellipsis && flow.next) {
			await this.applyEllipsis(flow, shaped);
		}

		const result = this.finalizeRegionResult(flow, spec);

		// visibleモード: 制約なしで配置した上でボックス超過だけ報告する
		if (spec.provider === null && layout.overflow === "visible") {
			const w = layout.boxWidth;
			const h = layout.boxHeight;
			if (
				(w !== "auto" && result.bounds.width > w + EPS) ||
				(h !== "auto" && result.bounds.height > h + EPS)
			) {
				result.hasOverflow = true;
			}
		}

		return result;
	}

	/**
	 * break+place相: ストリームをリージョンへ貪欲に流し込む
	 */
	private flowIntoRegion(
		shaped: ShapedStream,
		start: FlowCursor,
		spec: RegionSpec,
	): RegionFlowResult {
		const { stream, paraMeta } = shaped;
		const legacy = spec.provider === null;
		const placed: PlacedLine[] = [];
		const allChars: LayoutedChar[] = [];
		let idx = start.idx;
		const first = paraMeta[start.p];
		// The band of the first line starts above the region by the leading
		// above its em box.
		let bandTop =
			spec.startTop +
			(spec.firstLineAtEmBox && first
				? (first.maxLineHeight - first.maxFontSize) * BASELINE_RATIO
				: 0);
		// Baseline of the last placed line. The next line's advance is the max
		// lineHeightPx of the chars that land in it (space-before, Illustrator-style)
		let prevBaseline: number | null = null;
		let emptyBandSkips = 0;

		const overflowAt = (
			p: number,
			paraEnd: number,
			paraPlaced: boolean,
		): RegionFlowResult =>
			this.buildFlowOverflowResult(
				shaped,
				placed,
				allChars,
				idx,
				p,
				paraEnd,
				paraPlaced,
			);

		for (let p = start.p; p < paraMeta.length; p++) {
			const meta = paraMeta[p];
			const lineH = meta.maxLineHeight;
			let paraEnd = idx;
			while (paraEnd < stream.length && stream[paraEnd].kind !== "break") {
				paraEnd++;
			}

			let firstLineOfPara = !(p === start.p && start.mid);
			let paraPlaced = p === start.p && start.mid;
			let itemsRemain = true;

			while (itemsRemain) {
				const baselineY = bandTop - lineH * BASELINE_RATIO;
				let intervals: TextLineInterval[];
				if (legacy) {
					intervals = [{ x0: 0, x1: Number.POSITIVE_INFINITY }];
				} else {
					// 区間評価はグリフのインクバンド（baseline±ascent/descent）で行う。
					// 行送り分の余白は形状外にはみ出してよい（行高さ全体で評価すると
					// 斜め上端の形状で先頭行の区間が過剰に痩せる）
					const inkTop = baselineY + meta.maxFontSize * BASELINE_RATIO;
					const inkBottom = baselineY - meta.maxFontSize * (1 - BASELINE_RATIO);
					// biome-ignore lint/style/noNonNullAssertion: legacy=false iff provider is set
					const iv = spec.provider!.intervalsForLine(inkTop, inkBottom);
					if (iv === null) return overflowAt(p, paraEnd, paraPlaced);
					if (iv.length === 0) {
						// バンドが形状の外（凹形状の上端など）: 1行ぶん下げて再試行
						bandTop -= lineH;
						if (prevBaseline != null) prevBaseline -= lineH;
						if (++emptyBandSkips > 10_000) {
							return overflowAt(p, paraEnd, paraPlaced);
						}
						continue;
					}
					intervals = iv;
				}

				const paraIsEmpty = idx >= paraEnd;
				// Line advance depends on the collected chars, so placement is
				// deferred until after collection
				const pendingLines: Array<{
					items: ShapedCharItem[];
					width: number;
					interval: TextLineInterval;
					softWrapped: boolean;
				}> = [];

				for (const interval of intervals) {
					const capacity = interval.x1 - interval.x0;
					const lineItems: ShapedCharItem[] = [];
					let width = 0;

					while (idx < paraEnd) {
						const it = stream[idx] as ShapedCharItem;
						const w =
							it.advanceWidth +
							it.kerning +
							it.letterSpacingPx +
							it.advanceAdjustPx;
						if (width + w > capacity + EPS) {
							// この区間に1文字も入らない: 次の区間/バンドへ
							if (lineItems.length === 0) break;
							// 行あふれ: 禁則を考慮して折り返し位置を探す
							let breakAt = lineItems.length;
							while (breakAt > 0) {
								const prevChar = lineItems[breakAt - 1].char;
								const nextChar =
									breakAt < lineItems.length
										? lineItems[breakAt].char
										: it.char;
								if (canBreakBetween(prevChar, nextChar)) break;
								breakAt--;
							}
							// 折り返し可能位置なし（行より長い単語）: 容量で強制分割
							if (breakAt === 0) breakAt = lineItems.length;
							const pushBack = lineItems.length - breakAt;
							if (pushBack > 0) {
								lineItems.length = breakAt;
								idx -= pushBack;
								width = lineItems.reduce(
									(sum, item) =>
										sum +
										item.advanceWidth +
										item.kerning +
										item.letterSpacingPx +
										item.advanceAdjustPx,
									0,
								);
							}
							break;
						}
						lineItems.push(it);
						width += w;
						idx++;
					}

					// 何も入らなかった区間には行を作らない（空段落の空行は除く）
					if (lineItems.length === 0 && !paraIsEmpty) continue;

					pendingLines.push({
						items: lineItems,
						width,
						interval,
						softWrapped: !firstLineOfPara,
					});
					firstLineOfPara = false;

					if (idx >= paraEnd) {
						itemsRemain = false;
						break;
					}
				}

				if (pendingLines.length === 0 && itemsRemain) {
					// このバンドの高さでは何も入らなかった（グリフより狭い先端など）:
					// 強制配置せず下へずらして再試行。終端は provider の null が保証する
					bandTop -= lineH;
					if (prevBaseline != null) prevBaseline -= lineH;
					if (++emptyBandSkips > 10_000) {
						return overflowAt(p, paraEnd, paraPlaced);
					}
					continue;
				}
				emptyBandSkips = 0;

				// Line advance = max lineHeightPx of chars in the band (empty
				// lines fall back to the paragraph default). Interval queries ran
				// at the provisional band position (paragraph max leading), so
				// mixed-leading lines inside inShape regions may sit slightly off
				// the queried band
				let bandLeading = 0;
				for (const pl of pendingLines) {
					for (const item of pl.items) {
						bandLeading = Math.max(bandLeading, item.lineHeightPx);
					}
				}
				if (bandLeading === 0) bandLeading = lineH;

				const yFinal =
					prevBaseline == null
						? legacy
							? bandTop
							: bandTop - bandLeading * BASELINE_RATIO
						: prevBaseline - bandLeading;

				for (const pl of pendingLines) {
					const startX = legacy
						? calcAlignOffset(meta.alignment, pl.width)
						: alignStartX(meta.alignment, pl.interval, pl.width);
					const chars = this.placeLineItems(pl.items, startX, yFinal);
					const line: LayoutedLine = {
						chars,
						width: pl.width,
						height: bandLeading,
						baseline: bandLeading * BASELINE_RATIO,
						x: startX,
						y: yFinal,
						paragraphIndex: p,
						softWrapped: pl.softWrapped,
					};
					placed.push({ line, x0: pl.interval.x0, x1: pl.interval.x1 });
					allChars.push(...chars);
					if (chars.length > 0) paraPlaced = true;
				}
				prevBaseline = yFinal;
				bandTop -= bandLeading;
			}

			// 段落終了: 区切りマーカーを跨いで次の段落へ
			idx = paraEnd + 1;
		}

		return { placed, chars: allChars, next: null };
	}

	/**
	 * place相: 行内アイテムのX座標を確定しLayoutedCharを生成
	 */
	private placeLineItems(
		items: ShapedCharItem[],
		startX: number,
		y: number,
	): LayoutedChar[] {
		const chars: LayoutedChar[] = [];
		let cursor = startX;
		for (const it of items) {
			const v = charVisualDelta(it.override, false);
			// A rotated glyph's widened cell centers the glyph so both gaps grow
			const cx = cursor + it.kerning + it.advanceAdjustPx / 2 + v.dx;
			const cy = y + v.dy;
			// Touch-type rotation spins the glyph around its advance midpoint on
			// the baseline; char.x/y stays the unrotated pen position so caret
			// and line-span math remain stable
			const anchor =
				v.rotRad === 0
					? { x: cx, y: cy }
					: rotateAnchorAroundPivot(
							cx,
							cy,
							cx + it.advanceWidth / 2,
							cy,
							v.rotRad,
						);
			chars.push({
				char: it.char,
				charIndex: it.charIndex,
				charLength: it.charLength,
				runIndex: it.runIndex,
				paragraphIndex: it.paragraphIndex,
				x: cx,
				y: cy,
				rotation: v.rotRad,
				fontSize: it.fontSize * it.sizeScale,
				font: it.font,
				glyphPath: this.transformGlyphPath(
					it.rawGlyphPath,
					anchor.x,
					anchor.y,
					glyphScale(it.sizeScale, it.override),
					v.rotRad,
					v.skewXRad,
					v.skewYRad,
				),
				advanceWidth: it.advanceWidth,
				colorLayers: it.colorLayers,
				kerningOffset: it.kerning,
				sizeScale: it.sizeScale,
				override: it.override,
			});
			// The visual offset never moves the pen: neighbours stay put
			cursor +=
				it.advanceWidth + it.kerning + it.letterSpacingPx + it.advanceAdjustPx;
		}
		return chars;
	}

	/** flowIntoRegion / flowIntoRegionVertical 共通のオーバーフロー結果生成 */
	private buildFlowOverflowResult(
		shaped: ShapedStream,
		placed: PlacedLine[],
		allChars: LayoutedChar[],
		idx: number,
		p: number,
		paraEnd: number,
		paraPlaced: boolean,
	): RegionFlowResult {
		const { stream, paraMeta } = shaped;
		if (idx >= stream.length) {
			return { placed, chars: allChars, next: null };
		}
		const item = stream[idx];
		const next: FlowCursor =
			idx === paraEnd
				? { p: p + 1, idx: idx + 1, mid: false }
				: { p, idx, mid: paraPlaced };
		if (next.p >= paraMeta.length) {
			return { placed, chars: allChars, next: null };
		}
		return {
			placed,
			chars: allChars,
			next,
			overflowStartIndex: item.charIndex,
		};
	}

	/**
	 * 縦書き版 break+place相: 列（上→下）を右から左へ流し込む
	 */
	private flowIntoRegionVertical(
		shaped: ShapedStream,
		start: FlowCursor,
		spec: VerticalRegionSpec,
	): RegionFlowResult {
		const { stream, paraMeta } = shaped;
		const placed: PlacedLine[] = [];
		const allChars: LayoutedChar[] = [];
		let idx = start.idx;
		let colRight = spec.startRight;
		// Right edge of the last placed column. The next column's advance is the
		// max lineHeightPx of the chars that land in it (space-before,
		// Illustrator-style)
		let prevColRight: number | null = null;
		let emptyBandSkips = 0;

		if (!spec.provider) {
			return { placed, chars: allChars, next: null };
		}
		const provider = spec.provider;

		for (let p = start.p; p < paraMeta.length; p++) {
			const meta = paraMeta[p];
			const colWidth = meta.maxFontSize;
			const colAdvance = meta.maxLineHeight;
			let paraEnd = idx;
			while (paraEnd < stream.length && stream[paraEnd].kind !== "break") {
				paraEnd++;
			}

			let firstColOfPara = !(p === start.p && start.mid);
			let paraPlaced = p === start.p && start.mid;
			let itemsRemain = true;

			while (itemsRemain) {
				const colLeft = colRight - colWidth;
				const iv = provider.intervalsForColumn(colLeft, colRight);
				if (iv === null) {
					return this.buildFlowOverflowResult(
						shaped,
						placed,
						allChars,
						idx,
						p,
						paraEnd,
						paraPlaced,
					);
				}
				if (iv.length === 0) {
					colRight -= colAdvance;
					if (prevColRight != null) prevColRight -= colAdvance;
					if (++emptyBandSkips > 10_000) {
						return this.buildFlowOverflowResult(
							shaped,
							placed,
							allChars,
							idx,
							p,
							paraEnd,
							paraPlaced,
						);
					}
					continue;
				}

				const paraIsEmpty = idx >= paraEnd;
				// Column advance depends on the collected chars, so placement is
				// deferred until after collection
				const pendingCols: Array<{
					items: ShapedCharItem[];
					used: number;
					interval: TextLineInterval;
					softWrapped: boolean;
				}> = [];

				for (const interval of iv) {
					// interval.x1 = 列の上端Y, interval.x0 = 下端Y
					const capacity = interval.x1 - interval.x0;
					const colItems: ShapedCharItem[] = [];
					let used = 0;

					while (idx < paraEnd) {
						const it = stream[idx] as ShapedCharItem;
						// 縦中横: consecutive flagged chars consume one upright cell
						// and wrap as an unbreakable unit
						let unitLen = 1;
						let advance =
							emHeightOf(it) +
							it.kerning +
							it.letterSpacingPx +
							it.verticalAdvanceAdjustPx;
						if (it.tateChuYoko) {
							let k = idx + 1;
							while (k < paraEnd && (stream[k] as ShapedCharItem).tateChuYoko) {
								k++;
							}
							unitLen = k - idx;
							advance = tateChuYokoAdvance(
								stream.slice(idx, k) as ShapedCharItem[],
							);
						}
						if (used + advance > capacity + EPS) {
							if (colItems.length === 0) break;
							// 列あふれ: 禁則を考慮して折り返し位置を探す（縦中横の
							// クラスタ内部では折り返さない）
							let breakAt = colItems.length;
							while (breakAt > 0) {
								const prevItem = colItems[breakAt - 1];
								const nextItem =
									breakAt < colItems.length ? colItems[breakAt] : it;
								const insideCluster =
									prevItem.tateChuYoko === true &&
									nextItem.tateChuYoko === true;
								if (
									!insideCluster &&
									canBreakBetween(prevItem.char, nextItem.char)
								) {
									break;
								}
								breakAt--;
							}
							if (breakAt === 0) breakAt = colItems.length;
							const pushBack = colItems.length - breakAt;
							if (pushBack > 0) {
								colItems.length = breakAt;
								idx -= pushBack;
								used = sumVerticalAdvances(colItems);
							}
							break;
						}
						for (let u = 0; u < unitLen; u++) {
							colItems.push(stream[idx + u] as ShapedCharItem);
						}
						used += advance;
						idx += unitLen;
					}

					if (colItems.length === 0 && !paraIsEmpty) continue;

					pendingCols.push({
						items: colItems,
						used,
						interval,
						softWrapped: !firstColOfPara,
					});
					firstColOfPara = false;

					if (idx >= paraEnd) {
						itemsRemain = false;
						break;
					}
				}

				if (pendingCols.length === 0 && itemsRemain) {
					colRight -= colAdvance;
					if (prevColRight != null) prevColRight -= colAdvance;
					if (++emptyBandSkips > 10_000) {
						return this.buildFlowOverflowResult(
							shaped,
							placed,
							allChars,
							idx,
							p,
							paraEnd,
							paraPlaced,
						);
					}
					continue;
				}
				emptyBandSkips = 0;

				// Column advance = max lineHeightPx of chars in the column (empty
				// columns fall back to the paragraph default). Interval queries ran
				// at the provisional position (paragraph max leading), so
				// mixed-leading columns inside inShape regions may sit slightly off
				// the queried band
				let colLeading = 0;
				for (const pc of pendingCols) {
					for (const item of pc.items) {
						colLeading = Math.max(colLeading, item.lineHeightPx);
					}
				}
				if (colLeading === 0) colLeading = colAdvance;

				// First column sits flush at the region's right edge; later
				// columns advance left from the previous column by their own leading
				const finalColRight =
					prevColRight == null ? colRight : prevColRight - colLeading;
				const finalColLeft = finalColRight - colWidth;

				for (const pc of pendingCols) {
					const colTop = alignColumnTop(
						meta.alignment,
						Number.isFinite(pc.interval.x0)
							? pc.interval
							: (spec.alignWithin ?? pc.interval),
						pc.used,
					);
					const chars = this.placeColumnItems(pc.items, finalColLeft, colTop);
					const line: LayoutedLine = {
						chars,
						width: colWidth,
						height: pc.used,
						baseline: colWidth / 2,
						x: finalColLeft,
						y: colTop,
						paragraphIndex: p,
						softWrapped: pc.softWrapped,
					};
					placed.push({ line, x0: pc.interval.x0, x1: pc.interval.x1 });
					allChars.push(...chars);
					if (chars.length > 0) paraPlaced = true;
				}
				prevColRight = finalColRight;
				colRight -= colLeading;
			}

			idx = paraEnd + 1;
		}

		return { placed, chars: allChars, next: null };
	}

	/** 縦書きの列内配置（縦書きグリフ置換・約物処理込み） */
	private placeColumnItems(
		items: ShapedCharItem[],
		colLeft: number,
		colTop: number,
	): LayoutedChar[] {
		const chars: LayoutedChar[] = [];
		let cursorTop = colTop;
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			if (it.tateChuYoko) {
				const cluster: ShapedCharItem[] = [];
				while (i < items.length && items[i].tateChuYoko) {
					cluster.push(items[i]);
					i++;
				}
				i--;
				const placed = this.placeTateChuYokoCluster(
					cluster,
					colLeft,
					cursorTop,
				);
				chars.push(...placed);
				cursorTop -= tateChuYokoAdvance(cluster);
				continue;
			}
			const fsScaled = emHeightOf(it);
			if (it.sideways) {
				chars.push(
					this.placeSideways(
						it,
						colLeft,
						cursorTop - it.kerning,
						it.advanceWidth,
					),
				);
				cursorTop -= it.advanceWidth + it.kerning + it.letterSpacingPx;
				continue;
			}
			const v = this.resolveVerticalGlyphPlacement(
				it.font,
				it.char,
				it.fontSize,
				it.rawGlyphPath,
			);
			const d = charVisualDelta(it.override, true);
			const charX = colLeft + v.offsetX + d.dx;
			// Center the glyph in its rotation-widened cell (flow runs downward)
			// Kerning moves the glyph along the flow before it, as in a row
			const charY =
				cursorTop -
				it.kerning -
				fsScaled * BASELINE_RATIO -
				it.verticalAdvanceAdjustPx / 2 +
				v.offsetY +
				d.dy;
			const rotation = v.rotation + d.rotRad;
			// Compose the touch-type spin (about the advance midpoint) on top of
			// the intrinsic vertical rotation (punctuation), keeping the
			// intrinsic anchor untouched when no override rotation is set
			const anchor =
				d.rotRad === 0
					? { x: charX, y: charY }
					: rotateAnchorAroundPivot(
							charX,
							charY,
							charX + it.advanceWidth / 2,
							charY,
							d.rotRad,
						);
			chars.push({
				char: it.char,
				charIndex: it.charIndex,
				charLength: it.charLength,
				runIndex: it.runIndex,
				paragraphIndex: it.paragraphIndex,
				x: charX,
				y: charY,
				rotation,
				fontSize: fsScaled,
				font: it.font,
				glyphPath: this.transformGlyphPath(
					v.path,
					anchor.x,
					anchor.y,
					glyphScale(it.sizeScale, it.override),
					rotation,
					d.skewXRad,
					d.skewYRad,
				),
				advanceWidth: it.advanceWidth,
				colorLayers: v.path === it.rawGlyphPath ? it.colorLayers : undefined,
				kerningOffset: it.kerning,
				sizeScale: it.sizeScale,
				override: it.override,
			});
			cursorTop -=
				fsScaled + it.kerning + it.letterSpacingPx + it.verticalAdvanceAdjustPx;
		}
		return chars;
	}

	/**
	 * A character laid on its side in a vertical column: turned a quarter turn
	 * clockwise, with its em box centred on the column and its advance running
	 * down from `cellTop`.
	 */
	private placeSideways(
		it: Pick<
			ShapedCharItem,
			| "char"
			| "charIndex"
			| "charLength"
			| "runIndex"
			| "paragraphIndex"
			| "fontSize"
			| "sizeScale"
			| "font"
			| "rawGlyphPath"
			| "colorLayers"
			| "kerning"
			| "override"
		>,
		colLeft: number,
		cellTop: number,
		advanceWidth: number,
	): LayoutedChar {
		const fsScaled = it.fontSize * it.sizeScale;
		const scale = sidewaysGlyphScale(it.sizeScale, it.override);
		const x = colLeft + it.fontSize * scale.y * (1 - BASELINE_RATIO);
		const rotation = -Math.PI / 2;
		return {
			char: it.char,
			charIndex: it.charIndex,
			charLength: it.charLength,
			runIndex: it.runIndex,
			paragraphIndex: it.paragraphIndex,
			x,
			y: cellTop,
			rotation,
			fontSize: fsScaled,
			font: it.font,
			glyphPath: this.transformGlyphPath(
				it.rawGlyphPath,
				x,
				cellTop,
				scale,
				rotation,
			),
			advanceWidth,
			colorLayers: it.colorLayers,
			kerningOffset: it.kerning,
			sizeScale: it.sizeScale,
			override: it.override,
			sideways: true,
		};
	}

	/**
	 * 縦中横: クラスタを1つの正立セル内に横組みで配置する。セル高さは
	 * クラスタ内最大のフォントサイズ、横方向は列軸に対して中央揃え。
	 */
	private placeTateChuYokoCluster(
		cluster: ShapedCharItem[],
		colLeft: number,
		cursorTop: number,
	): LayoutedChar[] {
		const maxFs = Math.max(...cluster.map((c) => c.fontSize * c.sizeScale));
		// Horizontal composition: a glyph's own kerning shifts itself like the
		// horizontal placement. Negative kerning can pull a glyph past the one
		// before it, so the span to center runs from the leftmost glyph edge to
		// the rightmost one. Spaces at the cluster's ends stay out of the span,
		// as in Japanese typesetting
		const lefts: number[] = [];
		let pen = 0;
		for (const c of cluster) {
			lefts.push(pen + c.kerning);
			pen += c.advanceWidth + c.kerning + c.letterSpacingPx;
		}
		const first = cluster.findIndex((c) => c.char.trim() !== "");
		const last = cluster.findLastIndex((c) => c.char.trim() !== "");
		const spanIndices = [...cluster.keys()].slice(
			first === -1 ? 0 : first,
			last === -1 ? cluster.length : last + 1,
		);
		const spanStart = Math.min(...spanIndices.map((i) => lefts[i]));
		const spanEnd = Math.max(
			...spanIndices.map((i) => lefts[i] + cluster[i].advanceWidth),
		);
		const originX = colLeft + (maxFs - (spanEnd - spanStart)) / 2 - spanStart;

		const placed: LayoutedChar[] = [];
		const baseY = cursorTop - maxFs * BASELINE_RATIO;
		for (const [i, c] of cluster.entries()) {
			// Overrides use the horizontal axes
			const d = charVisualDelta(c.override, false);
			const charX = originX + lefts[i] + d.dx;
			const charY = baseY + d.dy;
			const anchor =
				d.rotRad === 0
					? { x: charX, y: charY }
					: rotateAnchorAroundPivot(
							charX,
							charY,
							charX + c.advanceWidth / 2,
							charY,
							d.rotRad,
						);
			placed.push({
				char: c.char,
				charIndex: c.charIndex,
				charLength: c.charLength,
				runIndex: c.runIndex,
				paragraphIndex: c.paragraphIndex,
				x: charX,
				y: charY,
				rotation: d.rotRad,
				fontSize: c.fontSize * c.sizeScale,
				font: c.font,
				glyphPath: this.transformGlyphPath(
					c.rawGlyphPath,
					anchor.x,
					anchor.y,
					glyphScale(c.sizeScale, c.override),
					d.rotRad,
					d.skewXRad,
					d.skewYRad,
				),
				advanceWidth: c.advanceWidth,
				colorLayers: c.colorLayers,
				kerningOffset: c.kerning,
				sizeScale: c.sizeScale,
				override: c.override,
				tateChuYoko: true,
			});
		}
		return placed;
	}

	/**
	 * 縦書きグリフの解決: OpenType vert 置換を優先し、無ければ文字種に応じて
	 * オフセット（句読点）または90度回転（括弧・長音等）でフォールバック
	 */
	private resolveVerticalGlyphPlacement(
		font: LoadedFont,
		char: string,
		fontSize: number,
		rawGlyphPath: CubicBezierSegment[],
	): {
		path: CubicBezierSegment[];
		offsetX: number;
		offsetY: number;
		rotation: number;
	} {
		const vertGlyphPath = this.fontManager.getVerticalGlyphPath(font, char);
		if (vertGlyphPath) {
			return {
				path: vertGlyphPath.map((seg) => ({
					start: seg.start
						? { x: seg.start.x * fontSize, y: seg.start.y * fontSize }
						: undefined,
					cp1: { x: seg.cp1.x * fontSize, y: seg.cp1.y * fontSize },
					cp2: { x: seg.cp2.x * fontSize, y: seg.cp2.y * fontSize },
					end: { x: seg.end.x * fontSize, y: seg.end.y * fontSize },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: seg.isMoved,
					isClosed: seg.isClosed,
				})),
				offsetX: 0,
				offsetY: 0,
				rotation: 0,
			};
		}

		const charClass = classifyVerticalChar(char);
		if (charClass === "offset") {
			// 句読点（、。等）: 右上にオフセット
			return {
				path: rawGlyphPath,
				offsetX: fontSize * 0.5,
				offsetY: fontSize * 0.5,
				rotation: 0,
			};
		}
		if (charClass === "rotate") {
			// 括弧・長音等: 時計回り90度回転
			return {
				path: rawGlyphPath,
				offsetX: 0,
				offsetY: 0,
				rotation: -Math.PI / 2,
			};
		}
		return { path: rawGlyphPath, offsetX: 0, offsetY: 0, rotation: 0 };
	}

	/**
	 * overflow:"ellipsis": 最終行の末尾を "…" グリフに差し替える
	 */
	private async applyEllipsis(
		flow: RegionFlowResult,
		shaped: ShapedStream,
	): Promise<void> {
		const last = flow.placed.at(-1);
		if (!last) return;

		// フォント/サイズは最終行の末尾文字（無ければストリーム先頭文字）に合わせる
		const refChar = last.line.chars.at(-1) ?? flow.chars.at(-1) ?? null;
		const refItem = shaped.stream.find(
			(it): it is ShapedCharItem => it.kind === "char",
		);
		const font = refChar?.font ?? refItem?.font;
		const fontSize = refChar
			? refChar.fontSize / (refChar.sizeScale || 1)
			: (refItem?.fontSize ?? 0);
		if (!font || fontSize <= 0) return;

		const shapedEllipsis = await this.fontManager.shapeText(
			font,
			"…",
			fontSize,
			{ letterSpacing: 0 },
		);
		const glyph = shapedEllipsis[0];
		if (!glyph) return;

		const capacity = last.x1 - last.line.x;
		// "…" が収まるまで末尾の文字を落とす
		while (
			last.line.chars.length > 0 &&
			last.line.width + glyph.advanceWidth > capacity + EPS
		) {
			const removed = last.line.chars.pop();
			if (!removed) break;
			last.line.width -= removed.advanceWidth + removed.kerningOffset;
			const flatIndex = flow.chars.lastIndexOf(removed);
			if (flatIndex >= 0) flow.chars.splice(flatIndex, 1);
		}

		const cx = last.line.x + last.line.width;
		const y = last.line.y;
		const lastReal = last.line.chars.at(-1);
		const ellipsisChar: LayoutedChar = {
			char: glyph.char,
			charIndex: lastReal ? lastReal.charIndex + (lastReal.charLength ?? 1) : 0,
			runIndex: lastReal?.runIndex ?? 0,
			paragraphIndex: last.line.paragraphIndex,
			x: cx,
			y,
			rotation: 0,
			fontSize,
			font,
			glyphPath: this.transformGlyphPath(glyph.path, cx, y, { x: 1, y: 1 }, 0),
			advanceWidth: glyph.advanceWidth,
			colorLayers: glyph.colorLayers,
			kerningOffset: 0,
			sizeScale: 1,
			synthetic: true,
		};
		last.line.chars.push(ellipsisChar);
		last.line.width += glyph.advanceWidth;
		flow.chars.push(ellipsisChar);
	}

	/**
	 * flow結果をLayoutResultへ変換。制約付きリージョンではリージョン外形を
	 * boundsに合算する（空リージョンでも選択可能にするため）
	 */
	private finalizeRegionResult(
		flow: RegionFlowResult,
		spec: { provider: unknown | null; regionBounds: BoundingBox | null },
	): LayoutResult {
		const lines = flow.placed.map((pl) => pl.line);
		let bounds = this.calculateBounds(flow.chars, lines);
		if (spec.provider !== null && spec.regionBounds) {
			bounds = unionBounds(bounds, spec.regionBounds);
		}
		return {
			lines,
			chars: flow.chars,
			bounds,
			hasOverflow: flow.next !== null,
			overflowStartIndex: flow.overflowStartIndex,
		};
	}

	/**
	 * 垂直書きレイアウト。折り返し・ボックス制約は扱わない
	 */
	private async layoutVertical(element: TextElement): Promise<LayoutResult> {
		const { content, defaultStyle } = element;
		const lines: LayoutedLine[] = [];
		const allChars: LayoutedChar[] = [];

		let currentX = 0; // 右から左へ
		let globalCharIndex = 0;

		for (let pIdx = 0; pIdx < content.paragraphs.length; pIdx++) {
			// 段落間の改行分をglobalCharIndexに加算
			if (pIdx > 0) {
				globalCharIndex++;
			}

			const para = content.paragraphs[pIdx];

			// Column advance = max leading among the column's runs (space-before,
			// Illustrator-style). The first column sits at the origin; later
			// columns advance left by their own leading
			let colLeading = 0;
			for (const run of para.runs) {
				const rs = this.mergeStyles(defaultStyle, run.style);
				colLeading = Math.max(
					colLeading,
					rs.fontSize * (rs.lineHeight ?? defaultStyle.lineHeight ?? 1.5),
				);
			}
			if (colLeading === 0) {
				const rs = this.mergeStyles(defaultStyle, para.runs[0]?.style);
				colLeading =
					rs.fontSize * (rs.lineHeight ?? defaultStyle.lineHeight ?? 1.5);
			}
			if (pIdx > 0) currentX -= colLeading;

			let currentY = 0;
			const lineChars: LayoutedChar[] = [];
			let lineWidth = 0;
			let lineHeight = 0;
			// 縦中横: consecutive flagged runs share one upright cell
			const tateChuYokoCluster: ShapedCharItem[] = [];

			for (let rIdx = 0; rIdx < para.runs.length; rIdx++) {
				const run = para.runs[rIdx];
				const runStyle = this.mergeStyles(defaultStyle, run.style);
				const font = await this.getRunFont(runStyle);
				const fontSize = runStyle.fontSize;

				// 列の幅を更新
				lineWidth = Math.max(lineWidth, fontSize);
				const letterSpacingPx = (runStyle.letterSpacing ?? 0) * fontSize;

				// 文字を配置
				const shaped = await this.fontManager.shapeText(
					font,
					run.text,
					fontSize,
					{ letterSpacing: runStyle.letterSpacing },
				);

				// Content-based indexing (see shapeContent)
				const runStart = globalCharIndex;

				if (runStyle.tateChuYoko === true && shaped.length > 0) {
					const runCluster: ShapedCharItem[] = shaped.map((glyph) => {
						const charOverride = run.charOverrides?.find(
							(o) => o.charIndex === glyph.charIndex,
						);
						const sizeScale = charOverride?.sizeMultiplier ?? 1;
						return {
							kind: "char",
							char: glyph.char,
							rawGlyphPath: glyph.path,
							colorLayers: glyph.colorLayers,
							advanceWidth:
								glyph.advanceWidth * glyphScale(sizeScale, charOverride).x,
							kerning: (charOverride?.kerningAdjust ?? 0) * fontSize,
							letterSpacingPx,
							advanceAdjustPx: 0,
							verticalAdvanceAdjustPx: 0,
							sizeScale,
							fontSize,
							font,
							runIndex: rIdx,
							paragraphIndex: pIdx,
							charIndex: runStart + glyph.charIndex,
							charLength: glyph.charLength ?? 1,
							lineHeightPx: 0,
							tateChuYoko: true,
							override: charOverride,
						};
					});
					tateChuYokoCluster.push(...runCluster);
					globalCharIndex = runStart + run.text.length;
					const nextRun = para.runs[rIdx + 1];
					if (
						nextRun?.text &&
						this.mergeStyles(defaultStyle, nextRun.style).tateChuYoko === true
					) {
						continue;
					}
					// placeTateChuYokoCluster anchors the cell top at cursorTop
					// (the region path's convention); this path's baseline sits
					// at currentY, so shift the cell top up by the ascent ratio
					const maxFs = Math.max(
						...tateChuYokoCluster.map((c) => c.fontSize * c.sizeScale),
					);
					const placed = this.placeTateChuYokoCluster(
						tateChuYokoCluster,
						currentX,
						currentY + maxFs * BASELINE_RATIO,
					);
					lineChars.push(...placed);
					currentY -= tateChuYokoAdvance(tateChuYokoCluster);
					lineHeight = -currentY;
					tateChuYokoCluster.length = 0;
					continue;
				}

				for (let i = 0; i < shaped.length; i++) {
					const glyph = shaped[i];
					// Run内のcharOverridesから読む（run-localインデックス）
					const charOverride = run.charOverrides?.find(
						(o) => o.charIndex === glyph.charIndex,
					);

					// カーニング調整（em単位 → px変換）
					const kerningEm = charOverride?.kerningAdjust ?? 0;
					const kerning = kerningEm * fontSize;
					const sizeScale = charOverride?.sizeMultiplier ?? 1;
					const scale = glyphScale(sizeScale, charOverride);

					if (isSidewaysInVertical(runStyle, glyph.char)) {
						// A glyph on its side runs its width down the column
						const advance = glyph.advanceWidth * scale.y;
						lineChars.push(
							this.placeSideways(
								{
									char: glyph.char,
									charIndex: runStart + glyph.charIndex,
									charLength: glyph.charLength ?? 1,
									runIndex: rIdx,
									paragraphIndex: pIdx,
									fontSize,
									sizeScale,
									font,
									rawGlyphPath: glyph.path,
									colorLayers: glyph.colorLayers,
									kerning,
									override: charOverride,
								},
								currentX,
								currentY - kerning + fontSize * scale.y * BASELINE_RATIO,
								advance,
							),
						);
						currentY -= advance + kerning + letterSpacingPx;
						lineHeight = -currentY;
						continue;
					}

					// 縦書きグリフ解決（vert置換 or 約物フォールバック）
					const v = this.resolveVerticalGlyphPlacement(
						font,
						glyph.char,
						fontSize,
						glyph.path,
					);
					const d = charVisualDelta(charOverride, true);
					const advScaled = glyph.advanceWidth * scale.x;
					// Rotated glyphs advance by their rotated em-box projection,
					// centered in the widened cell (flow runs downward)
					const vAdvanceAdjust =
						d.rotRad !== 0
							? fontSize * scale.y * (Math.abs(Math.cos(d.rotRad)) - 1) +
								advScaled * Math.abs(Math.sin(d.rotRad))
							: 0;
					const charX = currentX + v.offsetX + d.dx;
					const charY =
						currentY - kerning + v.offsetY + d.dy - vAdvanceAdjust / 2;
					const charRotation = v.rotation + d.rotRad;
					const finalGlyphPath = v.path;
					const anchor =
						d.rotRad === 0
							? { x: charX, y: charY }
							: rotateAnchorAroundPivot(
									charX,
									charY,
									charX + advScaled / 2,
									charY,
									d.rotRad,
								);

					const layoutedChar: LayoutedChar = {
						char: glyph.char,
						charIndex: runStart + glyph.charIndex,
						charLength: glyph.charLength ?? 1,
						runIndex: rIdx,
						paragraphIndex: pIdx,
						x: charX,
						y: charY,
						rotation: charRotation,
						fontSize: fontSize * sizeScale,
						font,
						glyphPath: this.transformGlyphPath(
							finalGlyphPath,
							anchor.x,
							anchor.y,
							scale,
							charRotation,
							d.skewXRad,
							d.skewYRad,
						),
						advanceWidth: advScaled,
						colorLayers:
							finalGlyphPath === glyph.path ? glyph.colorLayers : undefined,
						kerningOffset: kerning,
						sizeScale,
						override: charOverride,
					};

					lineChars.push(layoutedChar);
					currentY -=
						fontSize * scale.y + kerning + letterSpacingPx + vAdvanceAdjust; // 上から下へ
					lineHeight = -currentY;
				}
				globalCharIndex = runStart + run.text.length;
			}

			// 空段落の場合のデフォルト列幅を計算
			if (lineWidth === 0) {
				const firstRunStyle = this.mergeStyles(
					defaultStyle,
					para.runs[0]?.style,
				);
				lineWidth = firstRunStyle.fontSize;
			}

			// The column was laid down from the origin: the top of its box, or
			// without a box, where an aligned one has its middle or its end.
			const columnTop = alignColumnTop(
				para.alignment,
				columnSpanOf(element.layout),
				lineHeight,
			);
			if (columnTop !== 0) {
				for (const char of lineChars) {
					char.y += columnTop;
					char.glyphPath = translateSegments(char.glyphPath, 0, columnTop);
				}
			}

			// 列を確定（空段落でも行を生成する）
			const line: LayoutedLine = {
				chars: lineChars,
				width: lineWidth,
				height: lineHeight,
				baseline: lineWidth / 2,
				x: currentX,
				y: columnTop,
				paragraphIndex: pIdx,
				softWrapped: false,
			};
			lines.push(line);
			allChars.push(...lineChars);
		}

		return {
			lines,
			chars: allChars,
			bounds: this.calculateBounds(allChars, lines),
			hasOverflow: false,
		};
	}

	/**
	 * パス上レイアウト
	 */
	private async layoutOnPath(
		element: TextElement,
		binding: TextOnPathBinding,
		segments: CubicBezierSegment[],
	): Promise<LayoutResult> {
		const { content, defaultStyle } = element;

		// パスセグメントがない場合は空を返す
		if (segments.length === 0) {
			return {
				lines: [],
				chars: [],
				bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
				hasOverflow: false,
			};
		}

		const shaped = await this.shapeContent(content, defaultStyle);
		const flow = this.flowOntoPath(
			shaped,
			{ p: 0, idx: 0, mid: false },
			binding,
			segments,
			element.layout.writingMode === "vertical-rl",
		);

		return {
			lines: [], // パス配置では行の概念なし
			chars: flow.chars,
			bounds: this.calculateBounds(flow.chars),
			hasOverflow: flow.next !== null,
			overflowStartIndex: flow.overflowStartIndex,
		};
	}

	/**
	 * ストリームをパス上へ流し込む。パス全長を超えた文字は打ち切り、
	 * 継続位置を返す（flowチェーンの下流へ流れる）。
	 * Vertical writing runs the column down the path, with the path through
	 * the middle of each character.
	 */
	private flowOntoPath(
		shaped: ShapedStream,
		start: FlowCursor,
		binding: TextOnPathBinding,
		segments: CubicBezierSegment[],
		vertical: boolean,
	): {
		chars: LayoutedChar[];
		next: FlowCursor | null;
		overflowStartIndex?: number;
	} {
		const { stream } = shaped;
		const chars: LayoutedChar[] = [];

		if (segments.length === 0) {
			// ジオメトリ未解決: 何も置けないが、文字は下流へ流さず保留する
			return { chars, next: null };
		}

		const arcLengths = buildArcLengthTable(segments);
		const pathLength = arcLengths.at(-1)?.cumulativeLength ?? 0;
		if (pathLength <= EPS) return { chars, next: null };
		// How far a character's cell runs along the path
		const cellLength = (it: ShapedCharItem) =>
			vertical && !it.sideways
				? emHeightOf(it) + it.verticalAdvanceAdjustPx
				: it.advanceWidth + it.advanceAdjustPx;

		// alignment center/right: 収まる幅を先に確定してから開始距離を決める（2パス）
		let totalWidth = 0;
		for (let i = start.idx; i < stream.length; i++) {
			const it = stream[i];
			if (it.kind === "char")
				totalWidth += cellLength(it) + it.kerning + it.letterSpacingPx;
		}
		const anchor = binding.startOffset * pathLength + (binding.offset ?? 0);
		let startDistance = anchor;
		if (binding.alignment === "center") startDistance = anchor - totalWidth / 2;
		else if (binding.alignment === "right") startDistance = anchor - totalWidth;
		startDistance = Math.max(0, startDistance);

		let currentDistance = startDistance;
		let idx = start.idx;
		let lastPlacedPara = start.mid ? start.p : null;

		while (idx < stream.length) {
			const it = stream[idx];
			if (it.kind === "break") {
				// パス配置では段落区切りは幅を持たない
				idx++;
				continue;
			}

			// パス全長を超える文字は打ち切り（オーバーフロー）
			if (currentDistance + it.kerning + cellLength(it) > pathLength + EPS)
				break;

			// 文字の中心位置をパス上に配置（回転で広がったセルの中央）
			const centerDistance = currentDistance + it.kerning + cellLength(it) / 2;
			const pathPoint = samplePathAtArcLength(
				segments,
				arcLengths,
				Math.max(0, centerDistance),
				pathLength,
			);
			if (!pathPoint) break;

			// Touch-type deltas: the spine point doubles as the rotation pivot,
			// so the extra rotation composes without anchor compensation
			const d = charVisualDelta(it.override, false);
			const tangentAngle = Math.atan2(-pathPoint.normalX, pathPoint.normalY);
			if (vertical && !it.sideways) {
				chars.push(this.placeUprightOnPath(it, pathPoint, tangentAngle, d));
				currentDistance += cellLength(it) + it.kerning + it.letterSpacingPx;
				lastPlacedPara = it.paragraphIndex;
				idx++;
				continue;
			}
			// A character on its side in vertical writing centres its em box
			// on the path, where horizontal writing sets its baseline
			const lift = vertical
				? -it.fontSize *
					sidewaysGlyphScale(it.sizeScale, it.override).y *
					(BASELINE_RATIO - 0.5)
				: 0;
			const cx = pathPoint.x + d.dx + pathPoint.normalX * lift;
			const cy = pathPoint.y + d.dy + pathPoint.normalY * lift;
			const rotation = tangentAngle + d.rotRad;

			chars.push({
				char: it.char,
				charIndex: it.charIndex,
				charLength: it.charLength,
				runIndex: it.runIndex,
				paragraphIndex: it.paragraphIndex,
				x: cx,
				y: cy,
				rotation,
				fontSize: it.fontSize * it.sizeScale,
				font: it.font,
				glyphPath: this.transformGlyphPath(
					it.rawGlyphPath,
					cx - (Math.cos(rotation) * it.advanceWidth) / 2,
					cy - (Math.sin(rotation) * it.advanceWidth) / 2,
					vertical
						? sidewaysGlyphScale(it.sizeScale, it.override)
						: glyphScale(it.sizeScale, it.override),
					rotation,
					d.skewXRad,
					d.skewYRad,
				),
				advanceWidth: it.advanceWidth,
				colorLayers: it.colorLayers,
				kerningOffset: it.kerning,
				sizeScale: it.sizeScale,
				override: it.override,
			});

			currentDistance += cellLength(it) + it.kerning + it.letterSpacingPx;
			lastPlacedPara = it.paragraphIndex;
			idx++;
		}

		if (idx >= stream.length) {
			return { chars, next: null };
		}

		const nextItem = stream[idx];
		const next: FlowCursor =
			nextItem.kind === "break"
				? { p: nextItem.paragraphIndex, idx: idx + 1, mid: false }
				: {
						p: nextItem.paragraphIndex,
						idx,
						mid: nextItem.paragraphIndex === lastPlacedPara,
					};
		return { chars, next, overflowStartIndex: nextItem.charIndex };
	}

	/**
	 * An upright character of vertical writing on a path: its column cell is
	 * centred on `point` and turned so the column runs down the path.
	 */
	private placeUprightOnPath(
		it: ShapedCharItem,
		point: { x: number; y: number },
		tangentAngle: number,
		d: ReturnType<typeof charVisualDelta>,
	): LayoutedChar {
		const v = this.resolveVerticalGlyphPlacement(
			it.font,
			it.char,
			it.fontSize,
			it.rawGlyphPath,
		);
		const scale = glyphScale(it.sizeScale, it.override);
		// The column's down direction turns onto the path's direction
		const turn = tangentAngle + Math.PI / 2;
		const cos = Math.cos(turn);
		const sin = Math.sin(turn);
		// The glyph's anchor in the column cell, measured from the cell centre
		const lx = v.offsetX - (it.fontSize * scale.x) / 2;
		const ly = v.offsetY - emHeightOf(it) * BASELINE_RATIO + emHeightOf(it) / 2;
		const x = point.x + d.dx + lx * cos - ly * sin;
		const y = point.y + d.dy + lx * sin + ly * cos;
		const rotation = turn + v.rotation + d.rotRad;
		return {
			char: it.char,
			charIndex: it.charIndex,
			charLength: it.charLength,
			runIndex: it.runIndex,
			paragraphIndex: it.paragraphIndex,
			x,
			y,
			rotation,
			fontSize: it.fontSize * it.sizeScale,
			font: it.font,
			glyphPath: this.transformGlyphPath(
				v.path,
				x,
				y,
				scale,
				rotation,
				d.skewXRad,
				d.skewYRad,
			),
			advanceWidth: it.advanceWidth,
			colorLayers: v.path === it.rawGlyphPath ? it.colorLayers : undefined,
			kerningOffset: it.kerning,
			sizeScale: it.sizeScale,
			override: it.override,
		};
	}

	/**
	 * スタイルをマージ
	 */
	private mergeStyles(
		base: TextStyle,
		override?: Partial<TextStyle>,
	): TextStyle {
		if (!override) return base;
		return {
			...base,
			...override,
			fontSource: override.fontSource ?? base.fontSource,
		};
	}

	/**
	 * グリフパスを変換（位置、スケール、回転）
	 * cp1/cp2は相対オフセットのため、平行移動を含まないtransformVectorで変換する
	 */
	private transformGlyphPath(
		path: CubicBezierSegment[],
		x: number,
		y: number,
		scale: { x: number; y: number },
		rotation: number,
		skewX = 0,
		skewY = 0,
	): CubicBezierSegment[] {
		const cos = Math.cos(rotation);
		const sin = Math.sin(rotation);
		const kx = skewX === 0 ? 0 : Math.tan(skewX);
		const ky = skewY === 0 ? 0 : Math.tan(skewY);

		// Linear map applied to a glyph offset (inner → outer): scale → shear → rotate.
		const applyLinear = (px: number, py: number): Point => {
			const sx = px * scale.x;
			const sy = py * scale.y;
			const hx = sx + kx * sy;
			const hy = sy + ky * sx;
			return { x: hx * cos - hy * sin, y: hx * sin + hy * cos };
		};

		/** アンカー点用: 線形変換 + 平行移動 */
		const transformPoint = (px: number, py: number): Point => {
			const v = applyLinear(px, py);
			return { x: v.x + x, y: v.y + y };
		};

		/** 相対オフセット用: 線形変換のみ（平行移動なし） */
		const transformVector = (vx: number, vy: number): Point =>
			applyLinear(vx, vy);

		return path.map((seg) => ({
			start: seg.start ? transformPoint(seg.start.x, seg.start.y) : undefined,
			cp1: transformVector(seg.cp1.x, seg.cp1.y),
			cp2: transformVector(seg.cp2.x, seg.cp2.y),
			end: transformPoint(seg.end.x, seg.end.y),
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: seg.isMoved,
			isClosed: seg.isClosed,
		}));
	}

	/**
	 * バウンディングボックスを計算
	 * 空行（改行のみの段落）も考慮してboundsを算出する
	 */
	private calculateBounds(
		chars: LayoutedChar[],
		lines?: LayoutedLine[],
	): BoundingBox {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		// グリフパスとフォントメトリクスからboundsを計算
		for (const char of chars) {
			// グリフ制御点でX方向のboundsを計算（ink bounds）
			for (let j = 0; j < char.glyphPath.length; j++) {
				const seg = char.glyphPath[j];
				const resolved = resolveSegment(
					seg,
					j > 0 ? char.glyphPath[j - 1].end : undefined,
				);
				const points = [
					resolved.start,
					resolved.cp1,
					resolved.cp2,
					resolved.end,
				];
				for (const p of points) {
					minX = Math.min(minX, p.x);
					minY = Math.min(minY, p.y);
					maxX = Math.max(maxX, p.x);
					maxY = Math.max(maxY, p.y);
				}
			}

			// フォントメトリクスでY方向を拡張（layout bounds）
			// ink boundsだけだと小文字"a"等でascent上端に到達せず高さが不足する
			const { ascent, descent, unitsPerEm } = char.font.fontkit;
			const ascentPx = (ascent / unitsPerEm) * char.fontSize;
			const descentPx = (descent / unitsPerEm) * char.fontSize;
			maxY = Math.max(maxY, char.y + ascentPx);
			minY = Math.min(minY, char.y + descentPx);

			// スペース文字（glyphPath空）のX範囲も含める
			minX = Math.min(minX, char.x);
			maxX = Math.max(maxX, char.x + char.advanceWidth);
		}

		// Include line-box expansion only for empty lines (newline-only paragraphs).
		// Non-empty lines are already covered by glyph geometry + font metrics.
		// Applying line.height here again makes bounds too large.
		if (lines) {
			for (const line of lines) {
				if (line.chars.length > 0) {
					continue;
				}
				const lineTop = line.y;
				const lineBottom = line.y - line.height;
				const lineRight = line.x + line.width;
				minX = Math.min(minX, Math.min(line.x, lineRight));
				maxX = Math.max(maxX, Math.max(line.x, lineRight));
				minY = Math.min(minY, lineBottom);
				maxY = Math.max(maxY, lineTop);
			}
		}

		if (!Number.isFinite(minX)) {
			return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
		}

		return {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
		};
	}
}

// --- Vertical text character classification (約物処理) ---

/** 縦書き時に90度回転すべき文字（括弧・長音・ダッシュ等） */
const VERTICAL_ROTATE_CHARS = new Set([
	// 括弧類
	"（",
	"）",
	"「",
	"」",
	"『",
	"』",
	"【",
	"】",
	"〈",
	"〉",
	"《",
	"》",
	"〔",
	"〕",
	"｛",
	"｝",
	"〖",
	"〗",
	"〘",
	"〙",
	"〚",
	"〛",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	// 長音・ダッシュ類
	"ー",
	"〜",
	"～",
	"―",
	"—",
	"–",
	"−",
	"＝",
	"…",
]);

/** 縦書き時に右上にオフセットすべき句読点 */
const VERTICAL_OFFSET_PUNCTUATION = new Set(["、", "。", "，", "．"]);

/**
 * 縦書き時の文字種別を判定
 * - "rotate": 90度時計回りに回転（括弧・長音等）
 * - "offset": 右上にオフセット（句読点）
 * - "normal": 変換不要（通常の全角文字）
 */
/**
 * Whether vertical writing in `style` lays `char` on its side: under
 * "mixed", every character whose Vertical_Orientation is R is.
 */
function isSidewaysInVertical(
	style: Pick<TextStyle, "textOrientation" | "tateChuYoko">,
	char: string,
): boolean {
	if (style.textOrientation !== "mixed" || style.tateChuYoko) return false;
	return !isUprightInVertical(char);
}

function classifyVerticalChar(char: string): "rotate" | "offset" | "normal" {
	if (VERTICAL_ROTATE_CHARS.has(char)) return "rotate";
	if (VERTICAL_OFFSET_PUNCTUATION.has(char)) return "offset";
	return "normal";
}

// --- Alignment helpers ---

/**
 * アラインメントに応じたX方向オフセットを算出
 * オブジェクト原点(x=0)が段落の左/中央/右になるように:
 *   left:   0（行は0から右に伸びる）
 *   center: -lineWidth/2
 *   right:  -lineWidth
 */
function calcAlignOffset(
	alignment: "left" | "center" | "right" | "justify",
	lineWidth: number,
): number {
	switch (alignment) {
		case "center":
			return -lineWidth / 2;
		case "right":
			return -lineWidth;
		default:
			return 0;
	}
}

/**
 * 制約付きリージョン内でのアラインメント: 区間内に行を配置する開始X
 */
function alignStartX(
	alignment: "left" | "center" | "right" | "justify",
	interval: TextLineInterval,
	lineWidth: number,
): number {
	switch (alignment) {
		case "center":
			return interval.x0 + (interval.x1 - interval.x0 - lineWidth) / 2;
		case "right":
			return interval.x1 - lineWidth;
		default:
			return interval.x0;
	}
}

/**
 * The span a column that nothing cuts is aligned in: the height of its box,
 * or without one, from the element's point down without end.
 */
function columnSpanOf(layout: TextLayout): TextLineInterval {
	return {
		x0:
			layout.boxHeight === "auto"
				? Number.NEGATIVE_INFINITY
				: -layout.boxHeight,
		x1: 0,
	};
}

/**
 * Top of a column of `columnHeight` in `interval`, which runs down from `x1`
 * to `x0`. A column with no bottom is anchored at its top instead: the top is
 * where a start-aligned column begins, a centered one has its middle and an
 * end-aligned one ends.
 */
function alignColumnTop(
	alignment: "left" | "center" | "right" | "justify",
	interval: TextLineInterval,
	columnHeight: number,
): number {
	const isAnchored = !Number.isFinite(interval.x0);
	switch (alignment) {
		case "center":
			return isAnchored
				? interval.x1 + columnHeight / 2
				: interval.x1 - (interval.x1 - interval.x0 - columnHeight) / 2;
		case "right":
			return isAnchored
				? interval.x1 + columnHeight
				: interval.x0 + columnHeight;
		default:
			return interval.x1;
	}
}

// --- Region bounds helpers ---

const EMPTY_BOUNDS: BoundingBox = {
	minX: 0,
	minY: 0,
	maxX: 0,
	maxY: 0,
	width: 0,
	height: 0,
};

function boxRegionBounds(
	boxWidth: number | "auto",
	boxHeight: number | "auto",
): BoundingBox {
	const w = boxWidth === "auto" ? 0 : boxWidth;
	const h = boxHeight === "auto" ? 0 : boxHeight;
	return { minX: 0, minY: -h, maxX: w, maxY: 0, width: w, height: h };
}

function polygonBounds(polygons: Point[][]): BoundingBox | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const polygon of polygons) {
		for (const p of polygon) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
	}
	if (!Number.isFinite(minX)) return null;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function unionBounds(a: BoundingBox, b: BoundingBox): BoundingBox {
	// 空bounds(全て0)はそのまま相手を返す
	if (a.width === 0 && a.height === 0 && a.minX === 0 && a.minY === 0) return b;
	const minX = Math.min(a.minX, b.minX);
	const minY = Math.min(a.minY, b.minY);
	const maxX = Math.max(a.maxX, b.maxX);
	const maxY = Math.max(a.maxY, b.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Per-char visual deltas from a touch-type CharOverride. offsetX/offsetY are
 * element-local visual axes regardless of writing mode; baselineShift moves
 * along the cross axis (up for horizontal, right for vertical). Rotation is
 * stored in degrees and returned in radians (Y-up, counterclockwise).
 */
function charVisualDelta(
	override: CharOverride | undefined,
	isVertical: boolean,
): {
	dx: number;
	dy: number;
	rotRad: number;
	skewXRad: number;
	skewYRad: number;
} {
	if (!override) return { dx: 0, dy: 0, rotRad: 0, skewXRad: 0, skewYRad: 0 };
	const shift = override.baselineShift ?? 0;
	return {
		dx: (override.offsetX ?? 0) + (isVertical ? shift : 0),
		dy: (override.offsetY ?? 0) + (isVertical ? 0 : shift),
		rotRad: ((override.rotation ?? 0) * Math.PI) / 180,
		skewXRad: ((override.skewX ?? 0) * Math.PI) / 180,
		skewYRad: ((override.skewY ?? 0) * Math.PI) / 180,
	};
}

/** How much `override` stretches a glyph drawn at `sizeScale`, along each glyph axis. */
function glyphScale(
	sizeScale: number,
	override: CharOverride | undefined,
): { x: number; y: number } {
	return {
		x: sizeScale * (override?.scaleX ?? 1),
		y: sizeScale * (override?.scaleY ?? 1),
	};
}

/**
 * `glyphScale` for a glyph laid on its side, whose own axes are turned a
 * quarter from the canvas's: the canvas height stretches its width.
 */
function sidewaysGlyphScale(
	sizeScale: number,
	override: CharOverride | undefined,
): { x: number; y: number } {
	const { x, y } = glyphScale(sizeScale, override);
	return { x: y, y: x };
}

/** The height of a glyph's em box, which an upright glyph advances by down a vertical line. */
function emHeightOf(it: ShapedCharItem): number {
	return it.fontSize * glyphScale(it.sizeScale, it.override).y;
}

/** 縦中横クラスタの縦送り量: 最大フォントサイズ + 末尾文字の字間 */
function tateChuYokoAdvance(cluster: ShapedCharItem[]): number {
	const maxFs = Math.max(...cluster.map((c) => c.fontSize * c.sizeScale));
	const last = cluster[cluster.length - 1];
	return maxFs + last.kerning + last.letterSpacingPx;
}

/** 縦フローの消費量合計（縦中横クラスタは1セルとして数える） */
function sumVerticalAdvances(items: ShapedCharItem[]): number {
	let sum = 0;
	for (let i = 0; i < items.length; ) {
		const it = items[i];
		if (it.tateChuYoko) {
			const cluster: ShapedCharItem[] = [];
			let j = i;
			while (j < items.length && items[j].tateChuYoko) {
				cluster.push(items[j]);
				j++;
			}
			sum += tateChuYokoAdvance(cluster);
			i = j;
			continue;
		}
		sum +=
			emHeightOf(it) +
			it.kerning +
			it.letterSpacingPx +
			it.verticalAdvanceAdjustPx;
		i++;
	}
	return sum;
}
