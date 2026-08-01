# TextTool 設計書

## 1. 概要

Paplico用のテキストツールの包括的な設計。Google Fonts・ローカルフォント対応、縦書き・横書き、パス沿いテキスト配置、個別文字調整など、プロフェッショナルな組版機能を実装。

---

## 2. フォントライブラリ選定

### 2.1 比較検討

| ライブラリ | サイズ | パフォーマンス | 主な特徴 |
|-----------|--------|--------------|---------|
| [opentype.js](https://opentype.js.org/) | ~440KB | 標準 | 定番、ドキュメント豊富 |
| [Typr.js](https://github.com/photopea/Typr.js) | ~110KB | 2-5x高速 | Photopea採用、軽量 |
| [Fontkit](https://github.com/foliojs/fontkit) | ~200KB | 標準 | WOFF2対応、AAT対応 |
| [harfbuzz.js](https://github.com/harfbuzz/harfbuzzjs) | ~1MB(WASM) | 高速 | 複雑スクリプト最高 |

### 2.2 推奨構成

```
メインエンジン: Fontkit
　├─ WOFF2サポート（Google Fontsで必須）
　├─ GSUB/GPOS完全サポート
　├─ カラー絵文字対応
　└─ フォントサブセッティング

シェーピング補助: HarfBuzz.js (WASM)
　├─ アラビア語・ウルドゥー語
　├─ デーヴァナーガリー文字
　└─ 複雑なリガチャ処理
```

**理由:**
- Fontkit: WOFF2サポートがGoogle Fontsで必須、Penpotも採用検討
- HarfBuzz: 複雑スクリプトの正確なシェーピングに必要、オプショナル読み込み

---

## 3. データ構造

### 3.1 TextElement型

```typescript
export interface TextElement {
  type: "text";
  id: string;

  // === 位置・変形 ===
  x: number;              // World座標 (バウンディングボックス左上)
  y: number;
  rotation: number;       // 度数法

  // === テキスト内容 ===
  content: TextContent;   // リッチテキスト構造

  // === レイアウト設定 ===
  layout: TextLayout;

  // === パス沿い配置 (オプション) ===
  pathBinding?: PathBinding;

  // === 共通プロパティ ===
  opacity: number;
  blendMode: BlendMode;
  filters?: Filter[];
  bounds?: BoundingBox;
  visible?: boolean;
}
```

### 3.2 TextContent（リッチテキスト構造）

```typescript
/**
 * テキストコンテンツ
 * 段落 > ラン(スタイル付きテキスト) の2層構造
 */
export interface TextContent {
  paragraphs: TextParagraph[];
}

export interface TextParagraph {
  runs: TextRun[];

  // 段落スタイル
  alignment: "left" | "center" | "right" | "justify";
  lineHeight: number;     // 1.0 = 100%
  indent: number;         // 先頭インデント (px)
  spacing: {
    before: number;       // 段落前スペース
    after: number;        // 段落後スペース
  };
}

export interface TextRun {
  text: string;
  style: TextStyle;

  // 個別文字調整（配列のインデックス = 文字位置）
  charOverrides?: CharOverride[];
}

export interface TextStyle {
  // フォント
  fontFamily: string;     // フォントファミリー名
  fontSource: FontSource; // フォント取得元情報
  fontSize: number;       // px
  fontWeight: number;     // 100-900
  fontStyle: "normal" | "italic" | "oblique";

  // 色
  fill: StrokeColor | null;     // 塗り
  stroke?: StrokeColor | null;  // ストローク（アウトライン）
  strokeWidth?: number;

  // 装飾
  underline: boolean;
  strikethrough: boolean;

  // 高度な設定
  letterSpacing: number;  // em単位 (0 = 標準)
  baselineShift: number;  // px (上付き・下付き)

  // OpenType Features
  openTypeFeatures?: Record<string, boolean>;
  // 例: { "liga": true, "kern": true, "smcp": false }
}

/**
 * 個別文字調整
 */
export interface CharOverride {
  charIndex: number;

  // カーニング調整 (Alt + 矢印キー)
  kerningAdjust?: number;  // em単位

  // サイズ調整
  sizeMultiplier?: number; // 1.0 = 100%

  // ベースラインシフト
  baselineShift?: number;  // px

  // 回転
  rotation?: number;       // 度
}
```

### 3.3 TextLayout

```typescript
export interface TextLayout {
  // 書字方向
  writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr";

  // テキストボックスサイズ
  boxWidth: number | "auto";   // "auto" = コンテンツに合わせる
  boxHeight: number | "auto";

  // オーバーフロー
  overflow: "visible" | "hidden" | "ellipsis";

  // 自動折り返し
  wordWrap: boolean;
}
```

### 3.4 PathBinding（パス沿い配置）

```typescript
export interface PathBinding {
  // バインド先パスのID
  pathId: string;

  // パス上の開始位置 (0.0 = 開始点, 1.0 = 終点)
  startOffset: number;

  // テキスト配置
  alignment: "left" | "center" | "right";

  // パスからのオフセット距離
  offsetDistance: number;  // px (正=外側, 負=内側)

  // 文字の向き
  orientation: "upright" | "rotate";  // upright=常に正立, rotate=パスに沿う
}
```

### 3.5 FontSource

```typescript
export type FontSource =
  | GoogleFontSource
  | LocalFontSource
  | EmbeddedFontSource;

export interface GoogleFontSource {
  type: "google";
  family: string;
  variants: string[];  // e.g., ["400", "700", "400italic"]
}

export interface LocalFontSource {
  type: "local";
  postScriptName: string;  // Local Font Access API用
}

export interface EmbeddedFontSource {
  type: "embedded";
  fileUid: string;  // EmbeddedFile.uid参照
}
```

---

## 4. フォント管理システム

### 4.1 FontManager

```typescript
class FontManager {
  private loadedFonts: Map<string, FontData>;
  private fontCache: Map<string, GPUTexture>;  // グリフアトラス

  /**
   * Google Fontsからフォント読み込み
   * APIキー: process.env.GOOGLE_FONTS_API_KEY
   */
  async loadGoogleFont(family: string, variants: string[]): Promise<FontData>;

  /**
   * Local Font Access APIでローカルフォント読み込み
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API
   */
  async loadLocalFont(postScriptName: string): Promise<FontData>;

  /**
   * 埋め込みフォント読み込み
   */
  async loadEmbeddedFont(fileUid: string, data: Uint8Array): Promise<FontData>;

  /**
   * 利用可能なローカルフォント一覧取得
   */
  async queryLocalFonts(): Promise<FontMetadata[]>;

  /**
   * Google Fonts検索
   */
  async searchGoogleFonts(query: string): Promise<GoogleFontMetadata[]>;

  /**
   * グリフのパスデータ取得
   */
  getGlyphPath(fontId: string, charCode: number): CubicBezierSegment[];

  /**
   * テキストシェーピング実行
   */
  shapeText(fontId: string, text: string, options: ShapingOptions): ShapedText;
}

interface ShapingOptions {
  direction: "ltr" | "rtl" | "ttb";
  script?: string;  // ISO 15924 (e.g., "Latn", "Jpan")
  language?: string;  // BCP 47 (e.g., "ja", "en")
  features?: Record<string, boolean>;
}

interface ShapedText {
  glyphs: ShapedGlyph[];
  advances: number[];
  positions: { x: number; y: number }[];
}

interface ShapedGlyph {
  glyphId: number;
  charIndex: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}
```

### 4.2 Google Fonts API連携

```typescript
class GoogleFontsAPI {
  private apiKey: string;
  private baseUrl = "https://www.googleapis.com/webfonts/v1/webfonts";

  constructor() {
    this.apiKey = process.env.GOOGLE_FONTS_API_KEY!;
  }

  /**
   * フォント一覧取得（キャッシュ付き）
   */
  async getFontList(): Promise<GoogleFont[]>;

  /**
   * フォント検索
   */
  async searchFonts(query: string): Promise<GoogleFont[]>;

  /**
   * フォントファイルダウンロード
   * WOFF2形式を優先取得
   */
  async downloadFont(family: string, variant: string): Promise<ArrayBuffer>;
}

interface GoogleFont {
  family: string;
  variants: string[];
  subsets: string[];  // ["japanese", "latin", etc.]
  category: string;   // "serif", "sans-serif", etc.
  files: Record<string, string>;  // variant -> URL
}
```

### 4.3 Local Font Access API連携

```typescript
class LocalFontAccess {
  /**
   * ブラウザがLocal Font Access APIをサポートしているか
   */
  static isSupported(): boolean {
    return "queryLocalFonts" in window;
  }

  /**
   * ローカルフォント一覧取得
   * 初回呼び出し時にユーザー許可ダイアログが表示される
   */
  async queryFonts(): Promise<FontMetadata[]> {
    const fonts = await window.queryLocalFonts();
    return fonts.map(font => ({
      family: font.family,
      fullName: font.fullName,
      postScriptName: font.postscriptName,
      style: font.style,
    }));
  }

  /**
   * 特定のフォントデータ取得
   */
  async getFontData(postScriptName: string): Promise<ArrayBuffer> {
    const fonts = await window.queryLocalFonts({
      postscriptNames: [postScriptName]
    });
    if (fonts.length === 0) {
      throw new Error(`Font not found: ${postScriptName}`);
    }
    const blob = await fonts[0].blob();
    return blob.arrayBuffer();
  }
}

interface FontMetadata {
  family: string;
  fullName: string;
  postScriptName: string;
  style: string;
}
```

---

## 5. 縦書き・横書き対応

### 5.1 WritingMode処理

```typescript
class VerticalTextHandler {
  /**
   * 縦書き時の文字配置計算
   */
  layoutVertical(
    shapedText: ShapedText,
    style: TextStyle,
    writingMode: "vertical-rl" | "vertical-lr"
  ): GlyphPosition[] {
    const positions: GlyphPosition[] = [];
    let y = 0;

    for (let i = 0; i < shapedText.glyphs.length; i++) {
      const glyph = shapedText.glyphs[i];
      const char = getCharFromGlyph(glyph);

      // Unicode縦書きプロパティに基づく回転判定
      const shouldRotate = this.shouldRotateInVertical(char);

      positions.push({
        x: shouldRotate ? style.fontSize / 2 : 0,
        y: y,
        rotation: shouldRotate ? 90 : 0,
      });

      // 縦書き時のアドバンス
      y += this.getVerticalAdvance(glyph, style.fontSize, shouldRotate);
    }

    return positions;
  }

  /**
   * 縦書きで90度回転すべき文字か判定
   * Unicode Standard Annex #50 に基づく
   */
  private shouldRotateInVertical(char: string): boolean {
    // 全角文字は正立
    if (this.isFullWidth(char)) return false;

    // 半角英数字・記号は回転
    if (this.isHalfWidth(char)) return true;

    // CJK句読点は正立
    if (this.isCJKPunctuation(char)) return false;

    return false;
  }

  private isFullWidth(char: string): boolean {
    const code = char.codePointAt(0)!;
    return (
      (code >= 0x3000 && code <= 0x9FFF) ||  // CJK
      (code >= 0xFF00 && code <= 0xFF60)     // 全角英数字
    );
  }

  private isHalfWidth(char: string): boolean {
    const code = char.codePointAt(0)!;
    return code >= 0x0020 && code <= 0x007E;  // ASCII
  }

  private isCJKPunctuation(char: string): boolean {
    const code = char.codePointAt(0)!;
    return (
      (code >= 0x3000 && code <= 0x303F) ||  // CJK句読点
      (code >= 0xFF01 && code <= 0xFF0F)     // 全角記号
    );
  }
}
```

### 5.2 縦書きレンダリング

縦書きテキストは以下の方法でWebGPUレンダリング:

1. **グリフごとの変換行列計算**
   - 正立文字: 通常配置
   - 回転文字: 90度回転 + 位置調整

2. **Tategaki OpenType Features**
   ```typescript
   const verticalFeatures = {
     "vert": true,  // 縦書き用代替グリフ
     "vrt2": true,  // 縦書き回転代替
     "vkrn": true,  // 縦書きカーニング
   };
   ```

---

## 6. パス沿いテキスト配置

### 6.1 PathTextLayoutEngine

```typescript
class PathTextLayoutEngine {
  /**
   * パス沿いにテキストを配置
   */
  layoutOnPath(
    shapedText: ShapedText,
    path: Path,
    binding: PathBinding
  ): PathTextPosition[] {
    // 1. パスの総長計算
    const pathLength = this.calculatePathLength(path.segments);

    // 2. テキスト幅計算
    const textWidth = this.calculateTextWidth(shapedText);

    // 3. 開始位置決定
    let startT = binding.startOffset;
    if (binding.alignment === "center") {
      startT -= (textWidth / pathLength) / 2;
    } else if (binding.alignment === "right") {
      startT -= textWidth / pathLength;
    }

    // 4. 各グリフの位置・回転計算
    const positions: PathTextPosition[] = [];
    let currentT = startT;

    for (let i = 0; i < shapedText.glyphs.length; i++) {
      const glyph = shapedText.glyphs[i];
      const advance = glyph.xAdvance;

      // パス上の位置と接線取得
      const { point, tangent } = this.getPointAndTangentAtT(
        path.segments,
        currentT
      );

      // 法線方向にオフセット
      const normal = { x: -tangent.y, y: tangent.x };
      const offsetPoint = {
        x: point.x + normal.x * binding.offsetDistance,
        y: point.y + normal.y * binding.offsetDistance,
      };

      // 回転角度
      let rotation = Math.atan2(tangent.y, tangent.x) * (180 / Math.PI);
      if (binding.orientation === "upright") {
        rotation = 0;  // 常に正立
      }

      positions.push({
        x: offsetPoint.x,
        y: offsetPoint.y,
        rotation,
        glyphIndex: i,
      });

      // 次の文字位置へ
      currentT += advance / pathLength;
    }

    return positions;
  }

  /**
   * ベジエ曲線の長さ計算（適応的サンプリング）
   */
  private calculatePathLength(segments: CubicBezierSegment[]): number {
    let length = 0;
    for (const seg of segments) {
      length += this.bezierLength(seg);
    }
    return length;
  }

  /**
   * 3次ベジエ曲線の長さ（ガウス積分）
   */
  private bezierLength(seg: CubicBezierSegment): number {
    // Gauss-Legendre quadrature with 5 points
    const weights = [0.2369, 0.4786, 0.5689, 0.4786, 0.2369];
    const abscissae = [-0.9062, -0.5385, 0, 0.5385, 0.9062];

    let length = 0;
    for (let i = 0; i < 5; i++) {
      const t = 0.5 + 0.5 * abscissae[i];
      const derivative = this.bezierDerivative(seg, t);
      const speed = Math.sqrt(derivative.x ** 2 + derivative.y ** 2);
      length += weights[i] * speed;
    }
    return length * 0.5;
  }

  /**
   * パス上のt位置での点と接線取得
   */
  private getPointAndTangentAtT(
    segments: CubicBezierSegment[],
    t: number
  ): { point: Point; tangent: Point } {
    // tを正規化してセグメントを特定
    const totalLength = this.calculatePathLength(segments);
    let targetLength = t * totalLength;

    let accumulatedLength = 0;
    for (const seg of segments) {
      const segLength = this.bezierLength(seg);
      if (accumulatedLength + segLength >= targetLength) {
        // このセグメント内の位置
        const localT = (targetLength - accumulatedLength) / segLength;
        return {
          point: this.bezierPoint(seg, localT),
          tangent: this.bezierTangent(seg, localT),
        };
      }
      accumulatedLength += segLength;
    }

    // 末尾
    const lastSeg = segments.at(-1)!;
    return {
      point: this.bezierPoint(lastSeg, 1),
      tangent: this.bezierTangent(lastSeg, 1),
    };
  }
}

interface PathTextPosition {
  x: number;
  y: number;
  rotation: number;  // degrees
  glyphIndex: number;
}
```

---

## 7. カーニング調整UI

### 7.1 キーボードショートカット

| 操作 | キー | 効果 |
|------|------|------|
| カーニング狭める | `Alt + ←` | -0.02em |
| カーニング広げる | `Alt + →` | +0.02em |
| 大きく狭める | `Alt + Shift + ←` | -0.1em |
| 大きく広げる | `Alt + Shift + →` | +0.1em |
| カーニングリセット | `Alt + Ctrl + 0` | 0em |
| 文字サイズ拡大 | `Ctrl + Shift + >` | +10% |
| 文字サイズ縮小 | `Ctrl + Shift + <` | -10% |

### 7.2 TextTool キー入力処理

```typescript
class TextTool implements Tool {
  readonly name = "text";

  private editState: TextEditState | null = null;

  onKeyDown(
    event: KeyboardEvent,
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
  ): boolean {
    if (!this.editState) return false;

    const { altKey, shiftKey, ctrlKey, key } = event;

    // カーニング調整
    if (altKey && !ctrlKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      event.preventDefault();
      const delta = shiftKey ? 0.1 : 0.02;
      const direction = key === "ArrowRight" ? 1 : -1;
      this.adjustKerning(delta * direction);
      return true;
    }

    // カーニングリセット
    if (altKey && ctrlKey && key === "0") {
      event.preventDefault();
      this.resetKerning();
      return true;
    }

    // 文字サイズ調整
    if (ctrlKey && shiftKey && (key === ">" || key === "<" || key === "." || key === ",")) {
      event.preventDefault();
      const multiplier = (key === ">" || key === ".") ? 1.1 : 0.9;
      this.adjustCharacterSize(multiplier);
      return true;
    }

    return false;
  }

  private adjustKerning(deltaEm: number): void {
    const { cursorPosition, textElement } = this.editState!;

    // カーソル位置の文字のカーニング調整
    const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
    const run = paragraph.runs[cursorPosition.run];

    run.charOverrides ??= [];

    let override = run.charOverrides.find(
      o => o.charIndex === cursorPosition.char
    );

    if (!override) {
      override = { charIndex: cursorPosition.char };
      run.charOverrides.push(override);
    }

    override.kerningAdjust = (override.kerningAdjust ?? 0) + deltaEm;

    this.requestRender();
  }
}

interface TextEditState {
  textElement: TextElement;
  cursorPosition: CursorPosition;
  selectionRange: SelectionRange | null;
  isEditing: boolean;
}

interface CursorPosition {
  paragraph: number;
  run: number;
  char: number;
}

interface SelectionRange {
  start: CursorPosition;
  end: CursorPosition;
}
```

---

## 8. WebGPUテキストレンダリング

### 8.1 レンダリング戦略

テキストレンダリングには3つのアプローチを検討:

| 方式 | 品質 | パフォーマンス | メモリ | ユースケース |
|------|------|--------------|--------|-------------|
| Path-based | ◎ 最高 | △ 遅い | ◯ 中 | 編集中・エクスポート |
| SDF | ◯ 良好 | ◎ 高速 | ◯ 中 | 表示・パン/ズーム |
| MSDF | ◎ 最高 | ◎ 高速 | △ 大 | 全般推奨 |

#### 1. Path-based rendering（高品質・低速）
- グリフアウトラインをベジエ曲線として取得
- 既存のPath描画パイプラインを再利用
- **利点**: 既存コードとの統合が容易、無限スケーラブル
- **欠点**: 大量テキストで遅い、GPUドローコール多い
- **適用**: エクスポート時、編集中の少量テキスト

#### 2. SDF (Signed Distance Field) rendering（高速・角が丸くなる）
- グリフをSDFテクスチャとしてキャッシュ
- 各ピクセルに「輪郭からの距離」を格納
- **利点**: ズーム時もアンチエイリアス維持、アウトライン/グロー等のエフェクト容易
- **欠点**: 鋭角コーナーが丸くなる
- **適用**: シンプルなフォント、UIテキスト

#### 3. MSDF (Multi-channel SDF) rendering（高品質・高速）
- RGB3チャンネルに方向別の距離情報を格納
- 中央値（median）計算で鋭角コーナーを復元
- **利点**: 高速かつ鋭角コーナー維持、3D回転にも対応
- **欠点**: アトラス生成コスト、メモリ使用量増
- **適用**: 全般的なテキストレンダリング

### 8.1.1 Paplico要件との適合性検討

#### 要件一覧

| 要件 | Path | SDF | MSDF | 備考 |
|------|------|-----|------|------|
| 無限ズーム品質維持 | ◎ | ◯ | ◎ | SDF/MSDFは十分実用的 |
| Google Fonts対応 | ◎ | ◯ | ◯ | 動的アトラス生成が必要 |
| ローカルフォント対応 | ◎ | ◯ | ◯ | 同上 |
| 縦書き対応 | ◎ | △ | △ | SDF系は回転処理が追加必要 |
| パス沿いテキスト | ◎ | ✕ | ✕ | グリフ個別回転が必要 |
| 個別文字サイズ調整 | ◎ | △ | △ | SDF系は頂点で対応可能 |
| カーニング微調整 | ◎ | ◎ | ◎ | 全方式対応 |
| 大量テキスト性能 | ✕ | ◎ | ◎ | Path系はドローコール増大 |
| メモリ効率 | ◎ | ◯ | △ | MSDF: 日本語で数十MB |
| 初期実装コスト | ◎ | ◯ | △ | Path=既存コード流用可 |
| エクスポート品質 | ◎ | ◯ | ◯ | ベクター出力はPathのみ |

#### 結論と推奨アーキテクチャ

**結論: Path-basedをメインに、オプショナルでMSDF高速化**

**理由:**

1. **パス沿いテキストの要件**
   - SDFは「テクスチャ+クワッド」方式のため、文字ごとの回転・変形が困難
   - パス沿い配置では各グリフが異なる角度で配置される
   - Path-basedなら既存のベジエレンダリングで対応可能

2. **動的フォント読み込み**
   - Google Fonts + ローカルフォントで数千フォント対応
   - 全フォントのMSDFアトラス事前生成は非現実的
   - ランタイム生成は数秒かかり、UX悪化

3. **日本語フォントのメモリ問題**
   - 常用漢字2136字 × MSDF = 数十MBのアトラス
   - フォント切り替えのたびにメモリ消費増大
   - ブラウザのメモリ制限に抵触リスク

4. **既存アーキテクチャとの整合性**
   - Paplicoは既にPath（ベジエ）レンダリングが最適化済み
   - テキスト=「グリフパスの集合」として扱えばコード再利用可
   - フィルター（Blur, ZigZag等）もPathと同じ方式で適用可能

**推奨実装:**

```
Phase 1: Path-based のみ
  └─ グリフパス → 既存Pathレンダリング
  └─ 全機能（縦書き、パス沿い、個別調整）をカバー

Phase 2 (オプション): MSDF高速化レイヤー
  └─ 条件: 大量テキスト + 変形なし + 頻繁なズーム
  └─ 実装: 使用中フォントのみオンデマンドでMSDFアトラス生成
  └─ 切り替え: ユーザー設定または自動判定

エクスポート: 常にPath-based
  └─ SVG互換ベクターデータ出力
```

**MSDF導入を再検討すべきタイミング:**
- 大量テキストを扱うユースケースが多発した場合
- パン/ズームが頻繁でパフォーマンス問題が顕在化した場合
- 限定フォント（システムフォント等）のみ対応する場合

### 8.2 MSDF詳細設計

#### 8.2.1 MSDFの仕組み

従来のSDFは単一チャンネル（グレースケール）に距離を格納するため、鋭角コーナーの情報が失われる。
MSDFは3チャンネル（RGB）を使い、異なる方向からの距離を格納することでコーナー情報を保持。

```
従来SDF:  各ピクセル = signed_distance(輪郭まで)
MSDF:     各ピクセル = (R: distance_1, G: distance_2, B: distance_3)

シェーダー処理:
  float distance = median(r, g, b);
  float alpha = smoothstep(0.5 - screenPxRange, 0.5 + screenPxRange, distance);
```

#### 8.2.2 MSDFアトラス生成

```typescript
class MSDFAtlasGenerator {
  /**
   * フォントからMSDFアトラスを生成
   *
   * 依存: msdf-bmfont-xml (npm) または msdf-atlas-gen (WASM)
   */
  async generateAtlas(
    fontData: ArrayBuffer,
    charset: string,
    options: MSDFAtlasOptions
  ): Promise<MSDFAtlas> {
    // オプション1: msdf-bmfont-xml (Node.js/ビルド時)
    // オプション2: msdf-atlas-gen WASM版 (ランタイム)
    // オプション3: 事前生成済みアトラスをCDNから取得

    const config: MSDFConfig = {
      fieldType: "msdf",
      distanceRange: options.distanceRange ?? 4,  // px
      fontSize: options.fontSize ?? 48,
      textureSize: options.textureSize ?? [2048, 2048],
    };

    // WASMでランタイム生成の場合
    const generator = await MSDFAtlasGenWASM.init();
    return generator.generate(fontData, charset, config);
  }

  /**
   * 日本語フォント用：文字セット最適化
   * 常用漢字2136字 + ひらがな + カタカナ + 記号
   */
  getJapaneseCharset(): string {
    return (
      HIRAGANA_CHARS +      // 82文字
      KATAKANA_CHARS +      // 96文字
      JOYO_KANJI +          // 2136字
      ASCII_PRINTABLE +     // 95文字
      PUNCTUATION_JP        // 約50文字
    );
    // Total: 約2500文字
  }
}

interface MSDFAtlasOptions {
  distanceRange?: number;  // SDF範囲（デフォルト: 4px）
  fontSize?: number;       // 基準フォントサイズ（デフォルト: 48px）
  textureSize?: [number, number];  // アトラステクスチャサイズ
}

interface MSDFAtlas {
  texture: ImageBitmap;
  metrics: MSDFMetrics;
  glyphs: Map<string, MSDFGlyph>;
}

interface MSDFGlyph {
  unicode: number;
  advance: number;  // 横送り幅
  planeBounds?: { left: number; bottom: number; right: number; top: number };
  atlasBounds: { left: number; bottom: number; right: number; top: number };
}

interface MSDFMetrics {
  emSize: number;
  lineHeight: number;
  ascender: number;
  descender: number;
  distanceRange: number;
}
```

#### 8.2.3 MSDFシェーダー

```wgsl
// msdf-text.wgsl

struct Uniforms {
  mvpMatrix: mat4x4<f32>,
  color: vec4<f32>,
  screenPxRange: f32,  // distanceRange * fontSize / atlasSize
  outlineWidth: f32,
  outlineColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var msdfTexture: texture_2d<f32>;
@group(0) @binding(2) var msdfSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
) -> VertexOutput {
  var out: VertexOutput;
  out.position = u.mvpMatrix * vec4<f32>(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}

// 中央値計算（MSDFの核心）
fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let msd = textureSample(msdfTexture, msdfSampler, in.uv).rgb;
  let sd = median(msd.r, msd.g, msd.b);

  // 画面ピクセル幅に基づくアンチエイリアス
  let screenPxDistance = u.screenPxRange * (sd - 0.5);
  let alpha = clamp(screenPxDistance + 0.5, 0.0, 1.0);

  // アウトライン（オプション）
  if (u.outlineWidth > 0.0) {
    let outlineDistance = u.screenPxRange * (sd - 0.5 + u.outlineWidth);
    let outlineAlpha = clamp(outlineDistance + 0.5, 0.0, 1.0);
    let outlineOnly = outlineAlpha - alpha;

    return vec4<f32>(
      mix(u.outlineColor.rgb, u.color.rgb, alpha),
      max(alpha, outlineOnly) * u.color.a
    );
  }

  return vec4<f32>(u.color.rgb, alpha * u.color.a);
}
```

#### 8.2.4 MSDFTextRenderer

```typescript
class MSDFTextRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private atlasCache: Map<string, MSDFAtlasGPU>;

  /**
   * MSDFでテキストをレンダリング
   */
  async render(
    textElement: TextElement,
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    viewport: Viewport
  ): void {
    const shapedText = this.shapeText(textElement);

    // フォントのMSDFアトラスを取得/生成
    const atlas = await this.getOrCreateAtlas(
      textElement.content.paragraphs[0].runs[0].style.fontFamily
    );

    // 頂点バッファ構築
    const vertices = this.buildVertices(shapedText, atlas, textElement);

    // screenPxRange計算
    // アトラス生成時のフォントサイズと表示フォントサイズの比率で調整
    const screenPxRange =
      (atlas.metrics.distanceRange * textElement.fontSize) /
      atlas.metrics.emSize;

    // レンダリング
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: "load",
        storeOp: "store",
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.createBindGroup(atlas, screenPxRange));
    pass.setVertexBuffer(0, vertices);
    pass.draw(shapedText.glyphs.length * 6);
    pass.end();
  }

  private buildVertices(
    shapedText: ShapedText,
    atlas: MSDFAtlasGPU,
    textElement: TextElement
  ): GPUBuffer {
    const vertices: number[] = [];

    let x = textElement.x;
    let y = textElement.y;

    for (const glyph of shapedText.glyphs) {
      const msdfGlyph = atlas.glyphs.get(String.fromCodePoint(glyph.unicode));
      if (!msdfGlyph) continue;

      // 個別文字調整を適用
      const charOverride = this.getCharOverride(textElement, glyph.charIndex);
      const sizeMultiplier = charOverride?.sizeMultiplier ?? 1.0;
      const kerningAdjust = charOverride?.kerningAdjust ?? 0;

      // クワッド頂点
      const scale = (textElement.fontSize * sizeMultiplier) / atlas.metrics.emSize;
      const { planeBounds, atlasBounds } = msdfGlyph;

      if (planeBounds) {
        const x0 = x + planeBounds.left * scale;
        const y0 = y + planeBounds.bottom * scale;
        const x1 = x + planeBounds.right * scale;
        const y1 = y + planeBounds.top * scale;

        const u0 = atlasBounds.left / atlas.textureWidth;
        const v0 = atlasBounds.bottom / atlas.textureHeight;
        const u1 = atlasBounds.right / atlas.textureWidth;
        const v1 = atlasBounds.top / atlas.textureHeight;

        // 2つの三角形（6頂点）
        vertices.push(
          x0, y0, u0, v0,
          x1, y0, u1, v0,
          x0, y1, u0, v1,
          x0, y1, u0, v1,
          x1, y0, u1, v0,
          x1, y1, u1, v1,
        );
      }

      // 次の文字位置
      x += (msdfGlyph.advance + kerningAdjust) * scale;
    }

    return this.createVertexBuffer(new Float32Array(vertices));
  }
}

interface MSDFAtlasGPU {
  texture: GPUTexture;
  textureView: GPUTextureView;
  textureWidth: number;
  textureHeight: number;
  metrics: MSDFMetrics;
  glyphs: Map<string, MSDFGlyph>;
}
```

#### 8.2.5 ハイブリッド戦略

```typescript
class HybridTextRenderer {
  private pathRenderer: PathBasedTextRenderer;
  private msdfRenderer: MSDFTextRenderer;

  /**
   * 状況に応じて最適なレンダラーを選択
   */
  render(textElement: TextElement, context: RenderContext): void {
    const strategy = this.selectStrategy(textElement, context);

    switch (strategy) {
      case "msdf":
        // 高速プレビュー
        this.msdfRenderer.render(textElement, context);
        break;

      case "path":
        // 高品質レンダリング（エクスポート等）
        this.pathRenderer.render(textElement, context);
        break;
    }
  }

  private selectStrategy(
    textElement: TextElement,
    context: RenderContext
  ): "msdf" | "path" {
    // エクスポート時はPath（最高品質）
    if (context.isExport) return "path";

    // パス沿いテキストはPath（変形が複雑）
    if (textElement.pathBinding) return "path";

    // 特殊エフェクト（フィルター）があればPath
    if (textElement.filters?.length) return "path";

    // 編集中でテキスト量が少なければPath
    if (context.isEditing && this.getCharCount(textElement) < 50) {
      return "path";
    }

    // それ以外はMSDF
    return "msdf";
  }
}
```

### 8.3 TextRenderer

```typescript
class TextRenderer {
  private fontManager: FontManager;
  private glyphCache: Map<string, GlyphCacheEntry>;

  /**
   * テキスト要素をレンダリング
   */
  render(
    textElement: TextElement,
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    targetTexture: GPUTexture,
    viewport: Viewport
  ): void {
    // 1. テキストシェーピング
    const shapedParagraphs = this.shapeText(textElement);

    // 2. レイアウト計算
    const layout = this.calculateLayout(textElement, shapedParagraphs);

    // 3. パス沿い配置（必要な場合）
    if (textElement.pathBinding) {
      this.applyPathBinding(layout, textElement.pathBinding);
    }

    // 4. グリフ描画
    for (const positioned of layout.glyphs) {
      const glyphPath = this.getGlyphPath(positioned);
      this.renderGlyphPath(
        glyphPath,
        positioned,
        device,
        encoder,
        targetTexture,
        viewport
      );
    }
  }

  /**
   * グリフをPathとして取得
   */
  private getGlyphPath(positioned: PositionedGlyph): Path {
    const { fontId, glyphId, style } = positioned;

    // キャッシュ確認
    const cacheKey = `${fontId}:${glyphId}:${style.fontSize}`;
    if (this.glyphCache.has(cacheKey)) {
      return this.glyphCache.get(cacheKey)!.path;
    }

    // フォントからグリフパス取得
    const segments = this.fontManager.getGlyphPath(fontId, glyphId);

    // スケーリング
    const scaledSegments = this.scaleSegments(segments, style.fontSize / 1000);

    const path: Path = {
      type: "path",
      id: `glyph-${cacheKey}`,
      color: style.fill ?? { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
      width: style.strokeWidth ?? 0,
      opacity: 1,
      blendMode: "normal",
      segments: scaledSegments,
    };

    this.glyphCache.set(cacheKey, { path });
    return path;
  }
}
```

---

## 9. TextTool実装

### 9.1 ツール状態

```typescript
class TextTool implements Tool {
  readonly name = "text";

  private options: TextToolOptions;
  private editState: TextEditState | null = null;
  private cursorBlinkTimer: number | null = null;
  private cursorVisible = true;

  constructor(options: TextToolOptions) {
    this.options = options;
  }

  // --- Tool Interface ---

  onPointerDown(
    event: PointerEventData,
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    const worldPos = screenToWorld(
      event.x, event.y, viewport, canvasWidth, canvasHeight
    );

    // 既存テキスト上をクリック → 編集モードに入る
    const hitText = this.hitTestText(worldPos);
    if (hitText) {
      this.enterEditMode(hitText, worldPos);
      return;
    }

    // 空白をクリック → 新規テキスト作成
    if (this.editState) {
      this.exitEditMode();
    }

    this.createNewText(worldPos);
  }

  onPointerMove(
    event: PointerEventData,
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    if (!this.editState?.isEditing) return;

    // テキスト選択中
    if (event.button === 0) {
      const worldPos = screenToWorld(
        event.x, event.y, viewport, canvasWidth, canvasHeight
      );
      this.extendSelection(worldPos);
    }
  }

  onPointerUp(): void {
    // 選択完了
  }

  onDoubleClick(
    event: PointerEventData,
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    if (!this.editState) return;

    // 単語選択
    const worldPos = screenToWorld(
      event.x, event.y, viewport, canvasWidth, canvasHeight
    );
    this.selectWord(worldPos);
  }

  onCancel(): void {
    if (this.editState) {
      this.exitEditMode();
    }
  }

  getCursor(): string {
    return this.editState ? "text" : "crosshair";
  }

  // --- 内部メソッド ---

  private createNewText(position: Point): void {
    const textElement: TextElement = {
      type: "text",
      id: nanoid(),
      x: position.x,
      y: position.y,
      rotation: 0,
      content: {
        paragraphs: [{
          runs: [{
            text: "",
            style: this.options.defaultStyle,
          }],
          alignment: "left",
          lineHeight: 1.2,
          indent: 0,
          spacing: { before: 0, after: 0 },
        }],
      },
      layout: {
        writingMode: "horizontal-tb",
        boxWidth: "auto",
        boxHeight: "auto",
        overflow: "visible",
        wordWrap: false,
      },
      opacity: 1,
      blendMode: "normal",
    };

    this.enterEditMode(textElement, position);
    this.options.onTextCreate?.(textElement);
  }

  private enterEditMode(
    textElement: TextElement,
    cursorWorldPos: Point
  ): void {
    this.editState = {
      textElement,
      cursorPosition: this.worldPosToCursor(textElement, cursorWorldPos),
      selectionRange: null,
      isEditing: true,
    };

    this.startCursorBlink();
    this.options.onEditStart?.(textElement);
  }

  private exitEditMode(): void {
    if (!this.editState) return;

    this.stopCursorBlink();

    // 空のテキストは削除
    if (this.isTextEmpty(this.editState.textElement)) {
      this.options.onTextDelete?.(this.editState.textElement.id);
    } else {
      this.options.onTextComplete?.(this.editState.textElement);
    }

    this.editState = null;
    this.options.onEditEnd?.();
  }

  private startCursorBlink(): void {
    this.cursorVisible = true;
    this.cursorBlinkTimer = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.requestRender();
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkTimer) {
      clearInterval(this.cursorBlinkTimer);
      this.cursorBlinkTimer = null;
    }
  }

  private requestRender(): void {
    this.options.onPreviewUpdate?.(this.editState?.textElement ?? null);
  }
}

interface TextToolOptions {
  defaultStyle: TextStyle;
  onTextCreate?: (text: TextElement) => void;
  onTextComplete?: (text: TextElement) => void;
  onTextDelete?: (id: string) => void;
  onEditStart?: (text: TextElement) => void;
  onEditEnd?: () => void;
  onPreviewUpdate?: (text: TextElement | null) => void;
}
```

---

## 10. フォントピッカーUI

### 10.1 コンポーネント構成

```
FontPicker
├── SearchInput
├── FontSourceTabs (Google | Local)
├── FontList
│   └── FontItem (プレビュー付き)
├── VariantSelector
└── FeatureToggles (OpenType features)
```

### 10.2 React Component

```typescript
interface FontPickerProps {
  value: FontSource;
  onChange: (source: FontSource) => void;
  previewText?: string;
}

function FontPicker({ value, onChange, previewText }: FontPickerProps) {
  const [tab, setTab] = useState<"google" | "local">("google");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: googleFonts } = useGoogleFonts(searchQuery);
  const { data: localFonts } = useLocalFonts();

  const fonts = tab === "google" ? googleFonts : localFonts;

  return (
    <div className="font-picker">
      <input
        type="text"
        placeholder="Search fonts..."
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
      />

      <div className="tabs">
        <button onClick={() => setTab("google")}>Google Fonts</button>
        <button onClick={() => setTab("local")}>Local Fonts</button>
      </div>

      <div className="font-list">
        {fonts?.map(font => (
          <FontItem
            key={font.id}
            font={font}
            selected={isSelected(font, value)}
            previewText={previewText}
            onClick={() => handleSelect(font)}
          />
        ))}
      </div>
    </div>
  );
}

function useGoogleFonts(query: string) {
  return useQuery({
    queryKey: ["googleFonts", query],
    queryFn: async () => {
      const api = new GoogleFontsAPI();
      return query ? api.searchFonts(query) : api.getFontList();
    },
    staleTime: 1000 * 60 * 60,  // 1時間キャッシュ
  });
}

function useLocalFonts() {
  return useQuery({
    queryKey: ["localFonts"],
    queryFn: async () => {
      if (!LocalFontAccess.isSupported()) {
        return [];
      }
      const access = new LocalFontAccess();
      return access.queryFonts();
    },
    staleTime: 1000 * 60 * 5,  // 5分キャッシュ
  });
}
```

---

## 11. YjsProvider拡張

### 11.1 TextElement用メソッド追加

```typescript
class YjsProvider {
  // 既存コード...

  /**
   * テキスト要素を追加
   */
  addTextElement(layerId: string, textElement: TextElement): void {
    this.doc.transact(() => {
      const layer = this.getYLayer(layerId);
      if (!layer) return;

      const elements = layer.get("elements") as Y.Array<any>;
      elements.push([this.textElementToYMap(textElement)]);
    });
  }

  /**
   * テキスト要素を更新
   */
  updateTextElement(
    layerId: string,
    elementId: string,
    updates: Partial<TextElement>
  ): void {
    this.doc.transact(() => {
      const element = this.getYElement(layerId, elementId);
      if (!element || element.get("type") !== "text") return;

      for (const [key, value] of Object.entries(updates)) {
        if (key === "content") {
          element.set("content", this.textContentToYMap(value as TextContent));
        } else {
          element.set(key, value);
        }
      }
    });
  }

  /**
   * テキストコンテンツを更新（リアルタイム編集用）
   */
  updateTextContent(
    layerId: string,
    elementId: string,
    content: TextContent
  ): void {
    this.doc.transact(() => {
      const element = this.getYElement(layerId, elementId);
      if (!element || element.get("type") !== "text") return;

      element.set("content", this.textContentToYMap(content));
    });
  }

  private textElementToYMap(text: TextElement): Y.Map<any> {
    const map = new Y.Map();
    map.set("type", "text");
    map.set("id", text.id);
    map.set("x", text.x);
    map.set("y", text.y);
    map.set("rotation", text.rotation);
    map.set("content", this.textContentToYMap(text.content));
    map.set("layout", text.layout);
    map.set("pathBinding", text.pathBinding ?? null);
    map.set("opacity", text.opacity);
    map.set("blendMode", text.blendMode);
    map.set("filters", text.filters ?? []);
    map.set("visible", text.visible ?? true);
    return map;
  }

  private textContentToYMap(content: TextContent): Y.Map<any> {
    const map = new Y.Map();
    const paragraphs = new Y.Array();

    for (const para of content.paragraphs) {
      const paraMap = new Y.Map();
      const runs = new Y.Array();

      for (const run of para.runs) {
        const runMap = new Y.Map();
        // Y.Text for collaborative editing
        runMap.set("text", new Y.Text(run.text));
        runMap.set("style", run.style);
        runMap.set("charOverrides", run.charOverrides ?? []);
        runs.push([runMap]);
      }

      paraMap.set("runs", runs);
      paraMap.set("alignment", para.alignment);
      paraMap.set("lineHeight", para.lineHeight);
      paraMap.set("indent", para.indent);
      paraMap.set("spacing", para.spacing);
      paragraphs.push([paraMap]);
    }

    map.set("paragraphs", paragraphs);
    return map;
  }
}
```

---

## 12. 実装フェーズ

### Phase 1: 基盤 (1-2週間)
- [ ] FontManager基本実装
- [ ] Google Fonts API連携
- [ ] TextElement型定義とYjsProvider拡張
- [ ] 基本TextTool（クリックでテキスト作成）

### Phase 2: 編集機能 (2-3週間)
- [ ] テキスト入力・編集
- [ ] カーソル表示・移動
- [ ] 選択範囲処理
- [ ] コピー・ペースト

### Phase 3: スタイリング (1-2週間)
- [ ] フォント選択UI
- [ ] Local Font Access API対応
- [ ] 文字サイズ・色・装飾
- [ ] カーニング調整（Alt+矢印）

### Phase 4: 高度な機能 (2-3週間)
- [ ] 縦書き対応
- [ ] パス沿いテキスト
- [ ] 個別文字サイズ調整
- [ ] OpenType Features

### Phase 5: 最適化 (1週間)
- [ ] グリフキャッシュ最適化
- [ ] SDF レンダリング（オプション）
- [ ] 大量テキストパフォーマンス

---

## 13. 参考資料

### フォントライブラリ
- [opentype.js](https://opentype.js.org/)
- [Typr.js](https://github.com/photopea/Typr.js)
- [Fontkit](https://github.com/foliojs/fontkit)
- [HarfBuzz.js](https://github.com/harfbuzz/harfbuzzjs)

### API・仕様
- [Google Fonts Developer API](https://developers.google.com/fonts/docs/developer_api)
- [Local Font Access API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API)
- [CSS Writing Modes (W3C)](https://www.w3.org/International/articles/vertical-text/)
- [Unicode Vertical Text (UAX #50)](https://unicode.org/reports/tr50/)

### デザインツール実装例
- [Penpot fontkit検討 Issue](https://github.com/penpot/penpot/issues/2049)
- [Figma Text Guide](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design)
- [Canvas-TextPath](https://github.com/Viglino/Canvas-TextPath)
- [svg-path-properties](https://www.npmjs.com/package/svg-path-properties)
