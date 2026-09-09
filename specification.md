# Paplico 技術仕様書

無限キャンバス描画アプリケーション - デジタルアーティスト・イラストレーター向けの本格的なお絵かきツール

## プロジェクト概要

Paplicoは、リアルタイム共同編集機能を備えた無限キャンバスの描画アプリケーションです。WebGPUによる高速レンダリングと、CRDT（Yjs）による堅牢な同期機構を採用しています。

### 主要機能

- ✏️ フリーハンド描画（スタンプ/リボン/幾何ストロークの3系統ブラシエンジン、筆圧・傾き対応、ウェットインク）
- 📐 ベクターパス編集（ベジエパス、ブーリアン演算、可変線幅、非破壊消去マスク）
- 📝 テキスト（縦書き・横書き、パス上配置、クローズパス内流し込み、複数リージョン連結）
- 🎨 レイヤー・グループ・クリッピングマスク・オブジェクトマスク
- 🪄 アピアランス/フィルタ（fill/stroke/3D押し出し/回転体/ブラー/スタイライズ等 44種）
- 🔁 リピート（グリッド/放射/ミラー）、ブレンド（Illustratorのブレンド相当）、メッシュ変形
- 🧊 3Dリファレンス（ポーズ人形・プリミティブのライン画/フラット表示）
- 👥 リアルタイム共同編集（local / cloud / E2EE の3モード）
- ⏱️ タイムラプス記録・再生・MP4書き出し
- 🤖 Syrup言語によるユーザー自動化スクリプト（Workerサンドボックス実行）
- 💾 papf（CBORベース独自バイナリ形式）での保存、PNG/JPEG/AVIF HDR/PSD/TIFF書き出し
- 🖥️ Tauri v2によるデスクトップ/iOSアプリ
- ↩️ Undo/Redo（Yjs UndoManager）

## 技術スタック

### フロントエンド

- **Next.js 16** - React 19ベースのフレームワーク
- **WebGPU** - キャンバスレンダリング（Canvas APIフォールバックなし）
- **Valtio** - 全リアクティブステート管理（ドキュメント・ツール設定・UI状態・アプリ設定）
- **Tailwind CSS 4** - スタイリング

### リアルタイム同期

- **Yjs** - CRDT（Conflict-free Replicated Data Type）ライブラリ
- **y-websocket** - localモードのWebSocketプロバイダ
- **y-partykit** - cloudモードのプロバイダ
- **partysocket + AES-GCM** - E2EEモードの自前暗号化リレー

### バックエンド

- **カスタムHTTPSサーバー（`pkgs/web/server.mjs`）** - localモードのNext.js + WebSocketサーバー
- **PartyKit（`pkgs/partykit-collab-server`）** - cloudモード/E2EEリレー
- **Supabase** - セッション認証（cloudモードのJWT検証）

### データ形式

- **CBOR（cbor-x）** - papfセクションペイロードのシリアライゼーション

## モノレポ構成

`pkgs/` 直下は6パッケージ:

```
pkgs/
├── web/                    # Next.js アプリ本体。描画エンジンは src/core/ に実装
├── desktop/                # Tauri v2 デスクトップ/iOS ラッパー（Rust は src-tauri/）
├── syrup/                  # @paplico/syrup - Syrupスクリプト言語（Paplico非依存）
├── avif-hdr/               # @paplico/avif-hdr - Pure TypeScript AVIF HDRエンコーダ
├── partykit-collab-server/ # cloudモード用 PartyKit サーバー
└── webgpu-devtools/        # WebGPUパイプライン検査用 WXT ブラウザ拡張
```

**重要：描画エンジンは `pkgs/web/src/core/` に実装する。**

## 座標系設計

実装場所：`pkgs/web/src/core/utils/geometry/geometry.ts`

無限キャンバスでは3つの座標系を使い分ける：

### 1. Screen Space（スクリーン座標）

```
原点：左上 (0, 0)
Y軸：下向きが正
単位：CSSピクセル
用途：PointerEvent入力、カーソル表示
```

### 2. World Space（ワールド座標）

```
原点：キャンバス中心 (0, 0)
Y軸：上向きが正（数学的座標系）
単位：論理ピクセル（ズーム非依存）
範囲：-∞ to +∞
用途：全要素の保存座標、共同編集の同期
```

### 3. NDC (Normalized Device Coordinates)

```
原点：中心 (0, 0)
Y軸：上向きが正
範囲：(-1, -1) to (1, 1)
用途：WebGPU頂点シェーダーへの入力
```

### Viewport

```typescript
interface Viewport {
	x: number;        // ビューポート中心のワールドX
	y: number;        // ビューポート中心のワールドY
	zoom: number;     // 1.0 = 100%（範囲 0.1〜640、core/document/constants.ts）
	rotation: number; // ビューポート回転（radians）
}
```

### 座標変換（回転対応）

```coffee
# スクリーン座標 → ワールド座標
screenToWorld(screenX, screenY, viewport, canvasW, canvasH) ->
  relX = screenX - canvasW / 2
  relY = screenY - canvasH / 2
  # ビューポート回転の逆回転
  cos = cos(-viewport.rotation); sin = sin(-viewport.rotation)
  unrotX = relX * cos - relY * sin
  unrotY = relX * sin + relY * cos
  return {
    x: viewport.x + unrotX / viewport.zoom
    y: viewport.y - unrotY / viewport.zoom  # Y軸反転
  }

# ワールド座標 → スクリーン座標
worldToScreen(worldX, worldY, viewport, canvasW, canvasH) ->
  relX = (worldX - viewport.x) * viewport.zoom
  relY = (viewport.y - worldY) * viewport.zoom  # Y軸反転
  cos = cos(viewport.rotation); sin = sin(viewport.rotation)
  rotX = relX * cos - relY * sin
  rotY = relX * sin + relY * cos
  return { x: canvasW / 2 + rotX, y: canvasH / 2 + rotY }

# ワールド座標 → NDC
worldToNDC(worldX, worldY, viewport, canvasW, canvasH) ->
  s = worldToScreen(worldX, worldY, viewport, canvasW, canvasH)
  return { x: (s.x / canvasW) * 2 - 1, y: 1 - (s.y / canvasH) * 2 }
```

可視範囲判定として `getVisibleWorldBounds`（rotation=0はfast path、回転時は4隅をscreenToWorldしてAABB化）、`isInViewport`、`boundsFullyInsideViewport`、`boundsIntersectViewport` を同ファイルで提供する。

## データ構造

実装場所：`pkgs/web/src/core/schema.ts`

### Document（正規化ストア）

```typescript
interface Document {
	id: string;
	objects: Record<string, AnyArtObject>; // 全ArtObjectのIDキー正規化ストア
	layers: Layer[];
	viewport: Viewport;          // プライマリキャンバスの保存値
	files: EmbeddedFile[];       // 埋め込みファイル（画像・ブラシテクスチャ）
	artboards: Artboard[];
	brushPresets: BrushPreset[];
	appearancePresets?: AppearancePreset[]; // アピアランスプリセット（AppearancePresetRef が参照）
	timelapse?: TimelapseData;
	schemaVersion?: number;      // YYYYMMDD形式。undefined = マイグレーション前のlegacy
	hdr?: HdrSettings;           // { enabled, exposure(EV) }
	colorProfile?: ColorProfileSettings; // { workingSpace: "srgb"|"display-p3", proofProfile?, proofIntent? }
	rasterizationDpi?: number;   // フィルタのラスタライズ解像度。72 = 1 texel/world px
	defs?: Record<string, DefEntry>;       // オフキャンバス定義（pattern / vector-brush）
	references3d?: Record<string, Reference3DDef>; // 3Dリファレンスシーン
}

interface Layer {
	id: string;
	name: string;
	visible: boolean;
	locked: boolean;
	opacity: number;
	blendMode?: BlendMode;
	elementIds: string[];          // document.objects へのID参照（表示順）
	transientKind?: TransientLayerKind; // "pattern-edit" | "mask-edit"。編集セッション作業面。保存・エクスポート除外
	ownerClientId?: string;        // transientレイヤの所有Yjs client ID（残骸GC用）
}
```

要素の実体は全て `document.objects` に置かれ、`Layer.elementIds` / コンテナの子ID配列はID参照のみを持つ。`defs` 配下の要素はレイヤーウォーカから構造的に到達不能で、レンダリング・ヒットテスト・エクスポートの対象外。

### Element union: `AnyArtObject`（9種）

| 型 | `type` | 概要 |
|---|---|---|
| `Path` | `"path"` | ベジエパス。`segments`, `isGuide?`, `pathStart?`/`pathEnd?`（分割ストロークのテーパー抑制）, `strokeWidths?`（可変線幅）, `eraseMasks?`（非破壊消去） |
| `Group` | `"group"` | `childIds`, `collapsed?`, `clipPathId?`（childIdsの1つをクリップパスに） |
| `CompoundPath` | `"compound-path"` | `sources: {id, op}[]`。op = `"union" \| "subtract" \| "intersect" \| "exclude"` |
| `ImageObject` | `"image"` | `fileUid`（EmbeddedFile参照）, 中心座標とサイズ, `corners?`（自由変形4隅） |
| `TextElement` | `"text"` | `content`, `defaultStyle`, `layout`, `axisBinding?`（パス上/シェイプ内）, `flow?`（リージョン連結）, `clipPathId?` |
| `MeshArtObject` | `"mesh"` | Coonsパッチケージによる非破壊ワープコンテナ。`childIds`, `vertices`, `faces`（quadのみ） |
| `BlendObject` | `"blend"` | オブジェクト間ブレンド。`objectIds`(≥2), `spacing`（steps/distance/smooth）, `spineSourceId?`, `tiltToSpine?` |
| `RepeatObject` | `"repeat"` | `mode: "grid" \| "radial" \| "mirror"`。3モードのパラメータを常時保持 |
| `Reference3DElement` | `"reference3d"` | 3Dシーン参照。`sceneId`, `camera`, `displayMode: "lineart" \| "flat"`, `includeInExport?` |

### ArtObject 共通基底

```typescript
interface ArtObject {
	id: string;
	name?: string;
	opacity: number;              // 0.0-1.0
	blendMode: BlendMode;
	compositionMode?: CompositionMode; // "normal" | "alpha-lock"
	visible?: boolean;            // undefined = true
	locked?: boolean;             // undefined = false
	filters?: Filter[];           // アピアランススタック
	transform: ElementTransform;  // { x, y, rotation, scaleX, scaleY, skewX?, skewY? }
	mask?: ObjectMask | null;     // グレースケールマスク（マスク要素の輝度がアルファを駆動）
}
```

`ElementTransform` はトップレベル要素ではワールド空間、グループ子では親ローカル空間で適用される。

### パスデータ

```typescript
interface BezierPoint {
	x: number;          // ワールドX（Y軸上向き、キャンバス中心原点）
	y: number;
	pressure?: number;  // 0.0-1.0
	tiltX?: number;     // -90〜90（度）
	tiltY?: number;
	deltaTime?: number; // ストローク開始からの累積経過ms
}

// 三次ベジエセグメント。start/endはワールド絶対座標のアンカー、
// cp1/cp2はアンカーからの相対オフセット（ワールド空間ベクトル）。
// 絶対座標への解決は utils/segmentOps.ts の resolveSegment() を使う。
interface CubicBezierSegment {
	start?: BezierPoint;    // サブパス最初のセグメントのみ。以降は前セグメントのendを始点に使う
	cp1: BezierPoint;       // startアンカーからの相対オフセット
	cp2: BezierPoint;       // endアンカーからの相対オフセット
	end: BezierPoint;
	startPressure?: number; // 0-1
	endPressure?: number;
	startTiltX: number;     // 度。必須
	startTiltY: number;
	endTiltX: number;
	endTiltY: number;
	startDeltaTime: number; // ms。必須
	endDeltaTime: number;
	isMoved: boolean;       // 新サブパスの開始（SVG moveTo相当）
	isClosed?: boolean;     // サブパスを閉じる（SVG Z相当）
}

interface PathSegment extends CubicBezierSegment {
	cornerRadius?: number;        // この頂点（end）の角丸半径。0/undefined = なし
	cornerSuperellipseN?: number; // 角丸の超楕円指数。2=円弧（デフォルト）、5=iOS風squircle
}
```

可変線幅は `StrokeWidthPoint { t, side1, side2 }`（tはパス全長正規化、side値はhalf-width比の符号付き境界オフセット、筆圧と乗算合成）で表現する。

### カラー表現

すべての色成分は0.0〜1.0で表現する。

```typescript
interface RGBColor { type: "rgb"; r: number; g: number; b: number; a: number }
interface HSVColor { type: "hsv"; h: number; s: number; v: number; a: number }
type Color = RGBColor | HSVColor;

interface ColorStop {
	offset: number;   // 0.0-1.0
	color: Color;
	midpoint: number; // Photoshop式の補間中点（0.5 = 線形）
}
```

**FillColor**（塗り）:

```typescript
type TexturedFill = LinearGradient | RadialGradient | FreeGradient | MeshGradient | PatternFill;
type FillColor = SolidColor | TexturedFill;
```

- `LinearGradient` — `x1,y1,x2,y2`（ワールド座標）+ stops
- `RadialGradient` — `cx,cy,radiusX,radiusY`（バウンディングボックス相対0-1）+ `rotation` + stops
- `FreeGradient` — フリーフォームグラデーション。stops（bbox相対座標 + `edgeCPs?`）をDelaunay三角形分割し、三角形Coonsパッチ + OKLab補間でGPUレンダリング
- `MeshGradient` — 自己完結型メッシュグラデーション（vertices/faces/handles、分割・派生色対応）
- `PatternFill` — `defId`（Document.defsのpattern参照）+ scale/rotation/offset。タイルは要素bboxにアンカーされ要素の変形に追従

**StrokeColor**（線）:

```typescript
type StrokeGradientMode = "within" | "along" | "across";
type StrokeColor = SolidColor | StrokeGradient | StrokePattern;
```

StrokeGradientの内包グラデーションはLinearGradientのみ（radial/free/meshは線に使えない）。

### BlendMode（12種）

```typescript
type BlendMode =
	| "normal" | "multiply" | "screen" | "overlay"
	| "darken" | "lighten" | "color-dodge" | "color-burn"
	| "hard-light" | "soft-light" | "difference" | "exclusion";
```

### Filter / Appearance

```typescript
interface Appearance<T = unknown> {
	uid: string;
	processor: string;        // filterCatalogに登録されたprocessor名
	enabled?: boolean;        // undefined = true
	opacity: number;
	blendMode: BlendMode;
	paramData: { version: string; params: T }; // バージョン付き（パラメータ移行用）
	applyToBackdrop?: boolean; // backdropに適用し要素形状でマスク
	subFilters?: Filter[];
}
type Filter<T = unknown> = Appearance<T>;
```

pre-filter（ジオメトリ変形）かpost-filter（テクスチャ処理）かは、FilterHandlerが `preProcess` / `postProcess` のどちらを実装するかで決まる（型レベルで排他）。processorは `fill` / `stroke` のアピアランス、3D（`extrude3d` / `revolve3d` / `3d-rotate`）、Geometry（`zigzag` / `path-offset` / `path-union` / `pucker-bloat`）、Blur / Color / Stylize / Distortion / Texture の `hk:*` シリーズ等、計44種が `renderer/filters/filterCatalog.ts` に登録されている。

### BrushSettings（5系統の判別ユニオン）

```typescript
type BrushType = "stroke" | "scatter" | "art" | "pattern" | "calligraphy";
type BrushSettings =
	| StrokeBrushSettings      // 幾何ストローク展開（lineCap/lineJoin/dash）
	| ScatterBrushSettings     // スタンプ散布（spacing/flow/stampRotation/wetInk等）
	| ArtBrushSettings         // リボン引き伸ばし
	| PatternBrushSettings     // リボンタイル
	| CalligraphyBrushSettings // 楕円ニブ（nibAngle/roundness/angleMode）
```

共通フィールド: `size`（ワールド単位）, `sizeByPressure`, `opacity`, `opacityByPressure`, `randomSeed`, `taperStart?`/`taperEnd?` 等。テクスチャソースは `BrushArtSource = {kind:"file"} | {kind:"def"}`。ビルトインブラシIDは `BUILTIN_BRUSH_IDS`（svg / hardCircle / softCircle / pencil / airbrush / calligraphy）。

### Artboard / EmbeddedFile

```typescript
interface Artboard {
	id: string; name: string;
	x: number; y: number;          // 中心のワールド座標
	width: number; height: number; // ワールド単位
	backgroundColor?: RGBColor;    // デフォルト白
}

interface EmbeddedFile {
	uid: string;
	name: string;
	type: string;      // MIMEタイプ
	hash: string;      // SHA-256（重複排除用）
	bin: Uint8Array;
}
```

## WebGPUレンダリングアーキテクチャ

実装場所：`pkgs/web/src/core/renderer/`

```
Paplico (facade) → RenderOrchestrator → CanvasLayer (ドキュメント描画, renderer/canvas/)
                                      → UILayer     (UIオーバーレイ, renderer/ui/)
```

### RenderOrchestrator

- GPUデバイスの取得・所有。`timestamp-query` が使えれば有効化し、storage buffer上限をアダプタ上限まで引き上げる
- HDR probe: `rgba16float` が使えてHDRが有効なら canvasFormat を `rgba16float`（既定 `bgra8unorm`、colorSpace `display-p3`）
- 複数の `CanvasTarget` を管理。CanvasLayer / UILayer / BackdropCaptureManager / RenderCacheManager はターゲット単位で、BrushRenderer は CanvasLayer が持つ、パイプライン・BrushTextureManager・FilterRenderer・TextRenderer等はデバイス単位で共有
- 1フレーム = 1 command encoder に CanvasLayer と UILayer を積んで1回 `queue.submit`
- デバイスロスト復旧: 最大5回、基本遅延1秒で再初期化を試行
- `GPUTimingProfiler` によるtimestamp queryベースのGPUパス計測

### RenderScheduler（レンダリング戦略）

DirtyReason（10種）: `document` / `viewport` / `preview` / `selection` / `editingScope` / `cursor` / `resize` / `collaboration` / `render` / `elementMove`

戦略（5種）の選択ロジック:

1. `document` / `editingScope` / `resize` / `collaboration` を含む → **`full`**（全再描画）
2. `elementMove` を含む → **`fullTransformOnly`**（boundsCacheを保持したまま再描画。移動・複製など形状不変の変更）
3. `viewport` かつインタラクション中:
   - `preview` / `render` が無く、transient 要素・override も無い → **`viewportBlit`**（ドキュメント描画をスキップし、キャッシュ済みcompositeを現ビューポートで再投影blit）
   - それ以外 → **`fullInteraction`**（`full` と同じパスで再描画）
4. `selection` / `cursor` だけで、blit を妨げる要因が無い → **`viewportBlit`**
5. それ以外 → **`overlayOnly`**（boundsCache などを保持したまま再描画。`preview` / `render`、settle 後の `viewport`）

CanvasLayer は有効な compositeFrameCache が無いか、キャッシュがビューポートを覆わないときに通常の再描画へフォールバックする。ビューポート操作は100msのsettleデバウンス後にフル品質で再描画する。

### フレームキャッシュ

`CanvasLayer.compositeFrameCache` がprebufと同サイズの合成結果テクスチャを保持し、`viewportBlit` 戦略時にpan/zoom/rotationを再投影blitで賄う。ダーティ追跡はレイヤー単位ではなく**要素ID単位**（`changedElements` の added/updated/deleted セット）で行い、変更要素とbounds連動する祖先・子孫のみ再合成する。

### パス描画（Sparse Strips）

Vello GPU 方式の被覆率ラスタライザ。ステンシルも MSAA も使わない:

1. **アウトライン** — `OutlineCache`。塗りは `flattenBezierPath` の閉じたポリライン、線は `tessellateStroke` の三角形。要素ローカル空間で、許容誤差はスケールバケット（`deviceScaleBucket`）から画面 0.25px 相当に決める
2. **strip 生成** — `renderer/geometry/strips/`。パスのテクセル空間へ変換した線分を 4×4px タイルに分配し、非ゼロ巻き数の面積積分で画素ごとの被覆率を求め、4px 高の strip と 8bit alpha スロットにする。左側にはみ出た線分は左端へ射影して巻き数を保つ。`StripCache` が変換の線形部分とサブピクセル位相をキーに保持し、整数テクセルのパンでは再利用する
3. **描画** — `StripFrame` がフレームの strip インスタンスと alpha ページを集め、submit 前に一括アップロードする。`strip.wgsl` が strip ごとの矩形をインスタンス描画し、alpha を `paintCommon.wgsl` のペイント段に掛ける。ペイントはインスタンス側なので不透明度の変更で再ラスタライズしない

自己交差・穴・複合パスは巻き数で処理する。線の三角形は向きを揃えて流し込むので結合部の重なりが 1 回だけ塗られ、半透明の線が交点で濃くならない。along/across のストロークグラデーションは CPU が画素ごとの (t, u) を params ページに書く。

### ストロークテッセレーション

`renderer/geometry/strokeTessellator.ts`。ポリラインサンプル化 → 可変幅・テーパーのゼロ交差でサブパス分割 → 法線計算 → 本体三角形（`[x, y]`）を出力。lineJoin（miter/round/bevel）、lineCap（butt/round/square）、破線対応。三角形は重なってよく、strip 生成が union を取る。

### ブラシストローク（3ルート）

`BrushSettings.engine` がルートを決める。呼び出し側（CanvasLayer / PathElementRenderer）がルートと stroke appearance を1回だけ解決し、`StrokeDrawInput` として描画側へ渡す:

| ルート | 描画側 | 方式 |
|---|---|---|
| `geometric` | `PathElementRenderer.renderGeometricStroke` | ストロークテッセレーション + GPUストロークパイプライン |
| `dab` | `BrushRenderer.render` が `DabRenderer.render` へ振り分ける | ベジエ曲線に沿った Dab のインスタンスド描画。先端形状・ニブ楕円率・回転は `BrushSettings.properties` のカーブ行列で決まる |
| `ribbon` | `RibbonRenderer.enqueue` / `flush`。即時描画は `BrushRenderer.render` | リボン頂点生成（UV stretch / UV repeat + tileSpacing）。バッチ蓄積に乗る唯一のルート |

- `DabEvaluator` がカーブ行列からDabごとのサイズ・不透明度を決定。`BoundedStampStore` の常駐GPUリースによりパン・ズームフレームではDabのアップロード0
- ビルトインブラシテクスチャ: hard circle / soft circle は128pxのプログラム生成、pencil / airbrush は同梱画像
- カスタムブラシテクスチャ: アップロード時に長辺基準で **1024 / 768 / 512 / 256 / 128** px の段階へアスペクト比保持でリサイズ（`utils/embeddedFile.ts`）

### ブレンドモード合成

非normalブレンドのみカスタムWGSLシェーダー（`shaders/composite.wgsl.ts` の `COMPOSITE_SHADER`）で合成する。normalは通常のpremultiplied alphaブレンドステートで描画。モード⇄インデックス対応は `BLEND_MODE_ORDER`（normal=0 〜 exclusion=11）。実行は `CompositeRenderer.compositeSurfaceToCanvas`。

### フィルタ実行

- **pre-filter**（`preProcess`）: ラスタライズ前にPathSegment配列を変形（zigzag等）。`PreFilterRenderer.applyPreFilters`
- **post-filter**（`postProcess`）: 要素のラスタライズ結果テクスチャにcompute/renderパスを適用。`FilterRenderer.applyFilters`
- **backdrop**: `BackdropCaptureManager` がprebufからワールド領域をキャプチャし、`BackdropEffectCoordinator` がフレーム内のbackdrop要求をバッチ計画。`rasterScale` 指定でワールドスナップされたラスタライズグリッドに再サンプルし、ズーム・パン不変のbackdropフィルタを実現。ブラーは分散空間でlerpする2レベルの `BlurPyramid`（半減ピラミッド、σ=2.0、最大7レベル）を共有

### オフスクリーン合成

- `OffscreenPresenter` — 要素/グループ/クリップグループのオフスクリーンテクスチャへの焼き込み、消去マスク適用、遅延テクスチャ破棄
- `CompositeRenderer` — 焼き上がったテクスチャのcanvasへのblit（通常/射影クアッド/メッシュ）とブレンド合成
- `ClipMaskAtlas` — フレーム冒頭に全クリップパスを白マスクとしてプリレンダし、メインパス中に要素ごとにバインド
- `TexturePool` — オフスクリーンテクスチャの再利用プール（予算 `min(1GiB, max(384MiB, canvasBytes×16))`、LRU退避）
- `FrameUniformPool` — フレーム毎uniformバッファのリング再利用
- `RenderPlanner` — GPU参照を持たない純データのフレーム計画（レイヤー合成要否、backdropによるパス分割宣言）を実行前に構築
- `FrameGraph` — パスのreads/writes依存グラフ

### レンダーキャッシュ

`RenderCacheManager` がドキュメント単位のスコープで10種のキャッシュを束ねる: `outline`（ローカル空間のポリラインと三角形、要素あたり最大6 variant）/ `strip`（被覆率 strip、要素あたり最大6 variant）/ `compoundPath` / `groupPath` / `meshWarp` / `stamp`（既定96MiB）/ `gradient`（GPUリソース束）/ `appearance` / `blend`。

### generators/

- `GradientTextureGenerator` — FreeGradientのDelaunay分割 + 三角形Coonsパッチcomputeシェーダー
- `MeshGradientTextureGenerator` — メッシュグラデーションのテクスチャ生成（2段キャッシュ）
- `CornerRadiusProcessor` — cornerRadius頂点への2パスフィレット適用（対象0個なら元配列をそのまま返す）

### UILayer

選択枠・パス編集ハンドル・ツールカーソル・マーキー・グラデーション編集・メッシュ変形・テキスト編集キャレット等のオーバーレイを描画する。collect（`UIOverlayState.overlays` のUIPrimitive収集）→ lower（z順ソートしてフィルrun / ベジエストロークrunに変換）→ draw（インスタンス描画してblit）の3段。ストロークはベジエセグメントをGPU上でクアッド展開、閉塗りはCPU earcut + 輪郭辺のみフラグメントAA。Z順は `ui/theme.ts` の `OVERLAY_Z` で管理する。

## ツールアーキテクチャ

実装場所：`pkgs/web/src/core/tools/`

```typescript
interface Tool {
	readonly name: string;
	onPointerDown(e: PointerEventData, viewport: Viewport, canvasWidth: number, canvasHeight: number): void;
	onPointerMove(e, viewport, canvasWidth, canvasHeight): void;
	onPointerUp(e, viewport, canvasWidth, canvasHeight): void;
	onCancel(): void;
	getCursor(): string;
	// optional
	onDoubleClick?(e, viewport, canvasWidth, canvasHeight): void;
	onKeyDown?(e: KeyboardEvent, viewport, canvasWidth, canvasHeight): boolean; // true = 処理済み
	onWheel?(e: WheelEventData, viewport, canvasWidth, canvasHeight): boolean;  // デフォルトのズーム/パンより先に呼ばれる
	onTouchGesture?(e: TouchGestureEventData, viewport, canvasWidth, canvasHeight): boolean; // "start"でtrueを返すと2本指ジェスチャを占有
	saveInterruptibleState?(): unknown;
	restoreFromInterrupt?(state: unknown): void;
	refreshUI?(): void;
	dispose?(): void;
}
```

`PointerEventData` はスクリーン座標・筆圧・傾き（度）・pointerType・接触サイズ・修飾キーを持つ。

**ツール一覧（16種）**: `pen` / `path` / `path-edit` / `select` / `eraser` / `shape` / `text` / `gradient` / `mesh-deform` / `free-transform` / `skew` / `artboard` / `bucket-fill` / `eyedropper` / `stroke-width-edit` / `reference3d`

ツールはエンジンへの直接参照を持たず、`ToolContext`（ドキュメント変更・選択・ヒットテスト・スナップ・オーバーレイ・テキスト編集・ビューポート等のコールバック集約）経由で操作する。ドキュメント変更は最終的に `PaplicoCommands` → `YjsProvider` に落ちる。

## 入力処理（PaplicoUI）

実装場所：`pkgs/web/src/core/ui/PaplicoUI.ts`

- **Pointer Events API**を使用（筆圧・傾き対応）。ジェスチャは単一の判別ユニオンstate machineで管理
- **パン**: 中クリック、またはSpace+ドラッグ（回転対応）
- **ズーム**: Ctrl+ホイール（macOSトラックパッドのピンチはctrlKey付きwheelとして届く）。カーソル下のワールド点を固定して補正。倍率は0.9/1.1固定、0.1〜640にクランプ
- **ホイール（修飾なし）**: deltaX/deltaYによるパン（回転対応）
- **2本指ジェスチャ**: 移動量サンプリングでpan-zoomと回転を判別。選択ツールで全指が選択bbox内ならオブジェクトのピンチリサイズ
- **マルチフィンガータップ**: 2本指タップ = Undo、3本指タップ = Redo
- **Alt+ドラッグ**（pen/eraser時）: ブラシサイズ変更
- **パームリジェクション**: ペン使用中のタッチ拒否、接触サイズ100px超の拒否。タッチ描画中にペンが来たらタッチストロークをキャンセルして復元
- **タッチ描画オフセット**: タッチ入力のpen/eraserのみY方向に60px（スケール可変）持ち上げ
- Safariのみ `GestureEvent`（トラックパッド回転・ピンチ）を併用

## ストローク処理（ペンツール）

実装場所：`pkgs/web/src/core/utils/geometry/strokeFitting.ts` の `processStroke()`

処理パイプライン:

1. **重複除去** — 0.5ワールド単位未満の連続点を間引く（終点は常に保持）
2. **スムージング** — `smoothingMethod` で選択:
   - `"smooth"`（既定）: ガウシアン加重移動平均。`sigma = stabilization × 4.0`。x/y/筆圧/傾き/deltaTimeを同一カーネルで平滑化。端点保持
   - `"pulled-string"`: 紐引きずり方式。紐長 = `stabilization × 20.0` ワールド単位
   - `"inertia"`: バネ-ダンパ（臨界減衰）。`stiffness = 4.0 × (1 - stabilization × 0.8)`
3. **コーナー検出** — 45°の角度閾値でポリラインを分割
4. **Schneider法による最小二乗三次ベジエフィッティング** — Newton-Raphson再パラメータ化（最大4回）。許容誤差はズーム反比例:

   ```
   baseTolerance = stabilization <= 0 ? 0.5 : 1.0 + stabilization * 3.0
   tolerance     = baseTolerance / viewport.zoom
   ```

5. **セグメント出力** — cp1/cp2をアンカー相対オフセットで格納。筆圧・傾き・deltaTimeは最寄りのスムージング済み点から転記

`deltaTime` は `onPointerDown` の `performance.now()` を起点とした累積経過msを各点に記録する。筆圧カーブ変換は `PaplicoUI` 側でマウス以外のポインタにのみ適用する。ライブプレビュー（`onPointerMove`）と確定（`onPointerUp`）の両方で同じ `processStroke` を通す。

ペンツールはこの他に、長押し（500ms）カラーピック、パースペクティブ定規への方向ロック（Altでバイパス）を持つ。

## キーボードショートカット

登録は `Paplico.ts` の `registerDefaultShortcuts()`（エンジン既定）と `app/page.tsx`（アプリ層）。物理キー `code` でマッチし、ユーザー設定が既定を上書きできる。

**ツール切替:**

- `V`: 選択 / `P`: パス / `B`: ペン / `E`: 消しゴム / `A`: パス編集 / `T`: テキスト / `G`: グラデーション / `I`: スポイト
- `M`: 矩形シェイプ / `L`: 楕円シェイプ / `Shift+W`: 線幅編集
- `D`: 変形ツールのサイクル（free-transform → mesh-deform → skew）

**グローバル（CtrlOrMeta = macはCmd / winはCtrl）:**

- `CtrlOrMeta+Z` / `Shift+CtrlOrMeta+Z`: Undo / Redo
- `CtrlOrMeta+C / X / V`: コピー / カット / ペースト
- `CtrlOrMeta+F` / `CtrlOrMeta+B`: 前面へペースト / 背面へペースト
- `CtrlOrMeta+G` / `Shift+CtrlOrMeta+G`: グループ化 / グループ解除
- `CtrlOrMeta+7`: クリッピングマスク
- `CtrlOrMeta+[` / `CtrlOrMeta+]`（`Alt+[` / `Alt+]` も可）: 重ね順変更
- `CtrlOrMeta+A` / `Shift+CtrlOrMeta+A`: 全選択 / 全選択解除
- `CtrlOrMeta+0`: ズーム・回転リセット
- `Escape`: 編集スコープを1段抜ける → 選択解除 / `Shift+Escape`: 編集スコープ全脱出
- `Delete` / `Backspace`: 選択要素削除
- `X`: 線/塗りのアクティブターゲット切替 / `Shift+X`: 線と塗りの色入れ替え / `/`: アクティブ色をなしに
- `CtrlOrMeta+\`: スプリットビュー切替

**ツール固有（抜粋）:**

- SelectTool: 矢印キーで移動（Shiftで10px単位）
- PathTool: `Enter` 確定 / `Escape` キャンセル / `Backspace` 最後のアンカー削除
- TextTool: `Alt+矢印` でカーニング・行送り調整（Shiftで大きく）、`CtrlOrMeta+Shift+> / <` で文字サイズ、`Alt+Ctrl+0` でカーニングリセット
- MeshDeformTool: `Enter` 適用 / `Delete` ハンドル削除
- Reference3DTool: ポーズモードで `1`〜`5` がプリセットポーズ

## リアルタイム共同編集

実装場所：`pkgs/web/src/core/collaboration/`

各クライアントはローカルにY.Docを持ち、Yjs CRDTの自動競合解決でドキュメントを同期する。Y.Docの変更は `syncYjsToValtio` でValtioに反映され再レンダリングされる。

### 3つのバックエンドモード

`createCollaboration()` ファクトリが選択する:

1. `config.roomKey` あり → **`E2EECollaboration`** — partysocket + AES-GCM自前暗号。Y.Doc update / awareness updateを暗号化し、状態を持たないPartyKitリレー（`relay.ts`）にブロードキャストさせる
2. `NEXT_PUBLIC_COLLAB_MODE === "cloud"` → **`PartyKitCollaboration`** — `y-partykit`。Supabaseセッショントークンをクエリ `token` で送り、PartyKitサーバーが `jose` でJWT検証（HS256、`SUPABASE_JWT_SECRET`）
3. それ以外（既定 = local） → **`Collaboration`** — `y-websocket` + カスタムサーバー（`server.mjs`）。`maxBackoffTime: 10s`、`resyncInterval: 30s`、BroadcastChannel無効

### Yjsデータモデル（正規化モデル）

Y.Docのトップレベルは8本:

```
Y.Doc
├─ "layers"       (Y.Array<Y.Map>)  レイヤー。elementIdsはY.Array<string>のID順序リスト
├─ "objects"      (Y.Map<Y.Map>)    全ArtObjectのフラットマップ（id → 要素Y.Map）
├─ "meta"         (Y.Map)           ドキュメントID・名前・オーナー
├─ "artboards"    (Y.Array)
├─ "files"        (Y.Map)           EmbeddedFile
├─ "brushPresets" (Y.Map<Y.Map>)
├─ "appearancePresets" (Y.Map<Y.Map>)
├─ "defs"         (Y.Map<Y.Map>)
└─ "references3d" (Y.Map<Y.Map>)
```

- 要素Y.Mapのフィールドは「スカラー直書き」（`SCALAR_FIELDS`）と「JSON文字列」（`JSON_FIELDS`）の2系統。どちらの集合にも無いキーは `updateElement` で黙って捨てられるため、schema拡張時は必ず追加する（`yjsFieldCoverage.test.ts` が検査）
- **viewportはY.Docに含めない**。ローカル状態（`RendererState.viewports`、CanvasTarget IDキー）で管理する

### Undo/Redo

- Yjs本体の `UndoManager` を使用。追跡ルートは `[yObjects, yLayers, yArtboards, yDefs, yReferences3d]`、`captureTimeout: 500ms`
- イベント `stack-item-added` / `stack-item-updated` / `stack-item-popped` でUI状態（`canUndo`/`canRedo`）とメタ（パス編集選択の復元）を更新
- `stopUndoCapture()` でグルーピングを打ち切り、1ドラッグ=1 undo stepを保証
- **規約: 全てのドキュメント変更はYjsProviderメソッド経由で行う。**Valtioのドキュメントデータを直接mutateしない
- データフロー: `User action → Tool → PaplicoCommands → YjsProvider → Y.Doc update → syncYjsToValtio → Valtio → React再レンダリング`。逆方向（Valtio→Yjs）の同期は存在しない

### Awareness API

共有フィールドは3つ: `user: { id, name, color }` / `readonly: boolean` / `cursor: { x, y } | null`（ワールド座標）。カーソルはpointermoveごとに更新する（専用スロットリングなし。Yjs Awarenessの差分送信に委ねる）。

### ローカルエコー

入力中のプレビューはAwarenessではなくローカルのValtio state（Yjsに流れない）で行う:

- `transientElements` — 描画中ストロークのプレビュー（sentinel ID `__pen_preview__`）。確定時にクリアして `commands.addPath`
- `elementOverrides` — ドラッグ中の要素差し替えプレビュー。commit時にクリアして `commands.updateElement`

### localサーバー（server.mjs）

- Next.jsカスタムHTTPSサーバー。`/api/collaboration` 配下のupgradeをy-websocket互換の自前 `setupWSConnection`（y-websocket v2 bin/utilsのインライン移植）へ流す
- Room管理はメモリ内（roomId → WSSharedDoc）。オーナー・readonly管理、Kick / CloseRoom制御メッセージ、`GET /api/collaboration/{roomId}/meta`
- 起動時にPIDを `pap.lock` へ書き込み、SIGINTで削除

## ステート管理

全リアクティブステートはValtioで管理する。

- **`RendererState`**（`core/document/rendererState.ts` で生成、型は `Paplico.ts`）: document / currentLayerId / canUndo・canRedo / elementOverrides・transientElements（`ref()` でプロキシ化回避）/ 選択状態 / uiOverlayState / 編集セッション / editingScopeStack / viewports 等を一括保持。外部へは読み取り専用の `PublicUIState`（`Paplico.uiState`）として公開
- **`stores/`**: `uiStore`（パネル開閉・アクティブターゲット等）、`documentStore`（Dexie/IndexedDBへのドキュメントCRUD）、`documentSessionStore`、`autoSave`、`notificationStore`、`hooks/useAppConfig.ts` の `appConfig`

## ファイル入出力

### papf形式（PAPF: Paplico Packed Format v1）

実装場所：`pkgs/web/src/core/io/papf/`

リトルエンディアンのセクション型バイナリコンテナ:

```
ファイルヘッダ "PAPF" (32B: magic, formatMajor=1, formatMinor=0, fileFlags, createdAt)
├─ セクション "PSEC" × n
│    META 0x0001  CBORドキュメントメタ
│    FILE 0x0002  埋め込みファイル生バイナリ
│    TMLH 0x0003  タイムラプスマニフェスト
│    TMLB 0x0004  タイムラプスブロック
│    TOC  0x00ff  目次（最終セクション）
└─ フッタ "PEND" (40B: TOCオフセット・サイズ、ファイルサイズ、TOC CRC32)
```

- 圧縮コーデック: None / Deflate（ブラウザネイティブCompressionStream）。既圧縮MIMEはNone
- ペイロードはCBOR（cbor-x）
- 保存時にGC: レイヤー・defsから到達不能なArtObjectと未参照filesを除去

### マイグレーション

`io/migrations/`。`Migration { version: YYYYMMDD; migrate(doc) }` を時系列順に適用し、`doc.schemaVersion` を更新する。ファイル名は `YYYYMMDD_mig_*.ts`。

### エクスポート

`io/export/`:

- **PNG / JPEG** — `PaplicoExporter`。ICCプロファイル埋め込み対応
- **AVIF HDR** — `@paplico/avif-hdr`（Pure TypeScriptエンコーダ、WASM・ネイティブ依存なし。10/12bit、PQ/HLG、BT.2020）
- **PSD** — `ag-psd` の `writePsd`。ICCはimage resource 1039に注入
- **TIFF** — 自前 `tiffWriter`。CMYK/RGB変換とレンダリングインテント指定に対応
- **MP4（タイムラプス）** — WebCodecs + MediaBunny（後述）

## タイポグラフィ

実装場所：`pkgs/web/src/core/typography/`

- **FontManager** — Google FontsとLocal Fonts（`core/infra/localfonts.dom.ts` / `.tauri.ts`）の統合マネージャ
- **TextLayoutEngine** — shape → break → place の3相レイアウト。水平/垂直書字、禁則処理付き行折り返し、ボックス制約とオーバーフロー（hidden/ellipsis/visible）、縦中横、文字単位カーニング
  - **パス上配置**（`axisBinding.mode === "onPath"`）: openパスを軸としてグリフを配置（パス全長で打ち切り）
  - **シェイプ内流し込み**（`"inShape"`）: closedパス内部へスキャンライン方式で流し込み（even-odd、穴対応）
  - **複数リージョン連結**（`layoutFlow` + `TextElement.flow`）: あふれたテキストを次のTextElementへ流す
- **TextRenderer** — グリフのベジエパスを通常のパス描画パイプラインに変換してレンダリング

## タイムラプス

実装場所：`pkgs/web/src/core/timelapse/`

- **TimelapseRecorder** — `ydoc.on("update")` のYjs updateを相対タイムスタンプ付きで記録（`TimelapseEntry { t, u }`）。papf import時は既存データに追記継続
- **TimelapsePlayer** — updateを順次適用して再生。パス描画アニメーション、キーフレームスナップショット、再生速度（1/2/5/10x）、アートボード絞り込み
- **TimelapseExporter** — WebCodecs（VideoEncoder）+ MediaBunnyでMP4書き出し。冒頭に完成形表示400ms → 白フェード300ms → 先頭から再生

## Syrup自動化スクリプティング

ユーザー自動化はSyrup（`.syrup`）で記述する。Swift風の静的型付き言語で、JavaScriptにコンパイルされる。言語リファレンスは `pkgs/syrup/specification.md`。

### pkgs/syrup（Paplico非依存）

```
syntax/ (chevrotainパーサ → AST) → checker/ (双方向型検査) → emit/ (JS出力)
host/ScriptHost   — compile / analyze / runTests、パッケージ登録、createWorkerRunner
runner/           — broker（メインスレッド: 実バインディング + handleテーブル）⇄ executor（Worker）
service/, monaco/ — LanguageService（補完・ホバー・シグネチャ・定義）+ エディタ統合
```

- スクリプトはWeb Workerで実行される。Workerはコンパイル済みコードのみを持ち、全ホスト呼び出しは `__host` RPCとしてメインスレッドの `RunnerBroker` が応答する
- ホストオブジェクトはhandle（`runner/marshal.ts`）としてWorker境界を越える。スクリプトから見える対象はプロキシであり、生のエンジンオブジェクトではない
- タイムアウト既定60秒。超過時はWorkerをterminateする

### Paplico側統合（pkgs/web/src）

- `scripting/api.ts` — `PAPLICO_SCRIPTING_DECLARATIONS`（スクリプトに見せるSyrup型宣言）と `registerPaplicoScriptingApi`。**宣言とランタイムバインディングは必ずここで同時に追加する**（型検査と実行時の不一致を防ぐ）
- `scripting/dom.ts` — `PaplicoAutomationDom`。バインディングを `PaplicoCommands` / `PaplicoSelection` 呼び出しに変換。スクリプトからのドキュメント変更もコマンド（＝YjsProvider）経由なのでUndoが正常に効く
- `scripting/runtime.ts` — `createPaplicoAutomationRuntime`。同時実行1スクリプト、60秒タイムアウト、`stdout` / `prompt` コールバックをUIから注入
- `automation/` — スクリプトカタログ。`builtins.ts`（読み取り専用サンプル6本）と `repository.ts`（localStorage上のユーザースクリプト。管理はTauriビルドのみ = `canManageUserScripts`）。UIは `dialogs/AutomationDialog.tsx`、ファイルアクセスは `infra/automationFileSystem.ts`

## Tauriデスクトップ

`pkgs/desktop/` がNext.jsの静的出力（`pkgs/web/out`）をTauri v2でラップする。iOSターゲットあり。

- UserAgent `"PaplicoDesktop"` を設定し、`IS_TAURI_ENV`（`pkgs/web/src/utils/platform.ts`）が主分岐フラグ
- Rustプラグイン: fs / dialog / sql / deep-link / oauth / system-fonts / safe-area-insets-css 等。自動化用ファイルアクセスコマンド群（`automation_*`）とネイティブメニューを提供
- プラットフォーム依存コードは `infra/` に隔離: `core/infra/`（エンジンが必要とするクリップボード・ローカルフォント）、`src/infra/`（filesystem / IndexedDB / Supabase / システムICCプロファイル）。実装は `.tauri.ts` / `.dom.ts` / `.web.ts` のファイル分割またはdynamic importで切り替える
- OAuth認証はシステムブラウザで実施し、dev時はlocalhostコールバック、本番は `paplico://` ディープリンクでトークンをアプリへ中継する

## エラーハンドリングとリカバリー

- **WebGPUデバイスロスト**: `device.lost` を監視し、最大5回・基本遅延1秒でデバイス再取得とレンダラー再初期化を試行
- **WebSocket切断**: localモードはy-websocketのExponential backoff（maxBackoffTime 10秒に上書き）+ 30秒ごとの再同期。E2EEモードは同期タイムアウト15秒で `syncTimeout` イベントを発火
- **再接続の判定**: sessionStorageの `paplico:reconnectInfo` とサーバーmetaのdocumentId一致で再接続と判断し、同期後に `deduplicateLayers()` を1回実行

## パフォーマンス最適化の要点

1. **レンダリング**
   - ビューポートカリング（可視範囲のみ描画）
   - 要素ID単位のダーティ追跡と差分再合成
   - ビューポート操作中と選択・カーソル更新時のcompositeフレームキャッシュblit（`viewportBlit`）
   - GPUリソースのプール/リング再利用（TexturePool・FrameUniformPool・GeometryStore）と常駐スタンプ
2. **データ転送**
   - papfのDeflate圧縮 + CBOR
   - Yjsの差分同期（変更分のみ送信）
   - Undoキャプチャ窓500msと `batchUpdateElements` による1トランザクション化
3. **共同編集**
   - ローカルエコー（transientElements / elementOverrides による即時反映）
   - Awarenessによる軽量なカーソル共有
