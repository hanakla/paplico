# Paplico 技術仕様書

無限キャンバス描画アプリケーション - デジタルアーティスト・イラストレーター向けの本格的なお絵かきツール

## プロジェクト概要

Paplico は、複数人でリアルタイムに共同編集できる。描画は WebGPU で高速に行う。同期には CRDT ライブラリの Yjs を使う。編集がぶつかっても、Yjs が自動で解決する。

### 主要機能

- ✏️ フリーハンド描画。ブラシエンジンは、スタンプ、リボン、幾何ストロークの3系統を持つ。筆圧、傾き、ウェットインクに対応する。
- 📐 ベクターパス編集。ベジエパス、ブーリアン演算、可変線幅を扱える。
- 📝 テキスト。縦書きと横書きに対応する。パスの上に文字を並べられる。閉じたパスの中に文字を流し込める。複数の領域をつないで、あふれた文字を次の領域へ流せる。
- 🎨 レイヤー、グループ、クリッピングマスク、オブジェクトマスク。
- 🪄 アピアランスとフィルタ。63種ある。fill、stroke、3D押し出し、回転体、パス変形、クリップ、ブラー、スタイライズ、SVGフィルタなどを含む。
- 🔁 リピート、ブレンド、メッシュ変形。リピートは、グリッド、放射、ミラーの3方式を持つ。ブレンドは Illustrator のブレンドに相当する。
- 🧊 3Dリファレンス。ポーズ人形、プリミティブ、glTF メッシュを下絵として置ける。表示は線画かフラットを選べる。
- 👥 リアルタイム共同編集。local、cloud、E2EE の3モードを持つ。
- ⏱️ タイムラプスの記録、再生、MP4 書き出し。
- 🤖 Syrup 言語によるユーザー自動化スクリプト。スクリプトは Worker のサンドボックスで実行する。
- 💾 保存形式は `.papf` である。ファイルは PDF コンテナである。その中に papf バイト列を格納する。書き出しは PNG、JPEG、AVIF HDR、PSD、TIFF、SVG に対応する。
- 🖥️ Tauri v2 によるデスクトップアプリと iOS アプリ。
- ↩️ Undo と Redo。Yjs の UndoManager を使う。

## 技術スタック

### フロントエンド

- **Next.js 16** - React 19 ベースのフレームワーク。
- **WebGPU** - キャンバスの描画に使う。Canvas API へのフォールバックは持たない。
- **Valtio** - すべてのリアクティブステートを管理する。対象は、ドキュメント、ツール設定、UI 状態、アプリ設定である。
- **Tailwind CSS 4** - スタイリングに使う。

### リアルタイム同期

- **Yjs** - CRDT ライブラリ。CRDT は Conflict-free Replicated Data Type の略である。
- **y-websocket** - local モードの WebSocket プロバイダ。
- **y-partyserver** - cloud モードのプロバイダ。
- **partysocket と AES-GCM** - E2EE モードで使う、自前で暗号化するリレー。

### バックエンド

- **カスタム HTTPS サーバー** - local モードで、Next.js と WebSocket を1つのサーバーで提供する。
  - `pkgs/web/server.mjs`
- **PartyServer** - cloud モードのサーバーと、E2EE のリレーを提供する。自分の Cloudflare アカウントの Worker と Durable Object で動く。
  - `pkgs/partykit-collab-server`
- **Supabase** - セッション認証を提供する。cloud モードでは、PartyServer のサーバーが Supabase の JWT を検証する。

### データ形式

- **@cantoo/pdf-lib** - `.papf` ファイルの外側にある PDF コンテナを読み書きする。
- **cbor-x** - papf の META、TMLH、TMLB セクションを CBOR でシリアライズする。

## モノレポ構成

`pkgs/` の直下には、7つのパッケージがある。

```
pkgs/
├── core/                   # @paplico/core - 描画エンジン
├── web/                    # Next.js アプリ本体
├── desktop/                # Tauri v2 のデスクトップ・iOS ラッパー。Rust は src-tauri/
├── syrup/                  # @paplico/syrup - Syrup スクリプト言語。Paplico に依存しない
├── avif-hdr/               # @paplico/avif-hdr - Pure TypeScript の AVIF HDR エンコーダ
├── partykit-collab-server/ # cloud モード用の PartyServer サーバー
└── webgpu-devtools/        # WebGPU パイプラインを調べる WXT ブラウザ拡張
```

**重要：描画エンジンは `pkgs/core/src/` に実装する。**

## 座標系設計

無限キャンバスでは、3つの座標系を使い分ける。入力はスクリーン座標で受け取る。保存と同期はワールド座標で行う。GPU には NDC で渡す。

実装場所：

- `pkgs/core/src/utils/geometry/space/coordinates.ts`

### 1. Screen Space：スクリーン座標

```
原点：左上 (0, 0)
Y軸：下向きが正
単位：CSSピクセル
用途：PointerEvent の入力、カーソル表示
```

### 2. World Space：ワールド座標

```
原点：キャンバス中心 (0, 0)
Y軸：上向きが正。数学の座標系と同じ
単位：論理ピクセル。ズームに依存しない
範囲：-∞ から +∞
用途：全要素の保存座標、共同編集の同期
```

### 3. NDC：Normalized Device Coordinates

```
原点：中心 (0, 0)
Y軸：上向きが正
範囲：(-1, -1) から (1, 1)
用途：WebGPU の頂点シェーダーへの入力
```

### Viewport

```typescript
interface Viewport {
	x: number;        // ビューポート中心のワールドX
	y: number;        // ビューポート中心のワールドY
	zoom: number;     // 1.0 = 100%
	rotation: number; // ビューポートの回転。単位はラジアン
}
```

`zoom` の下限は0.1である。上限は、ユーザー設定の `maxZoomScale` で決まる。`maxZoomScale` は、1から640の範囲に収める。これらの定数は次のファイルにある。

- `pkgs/core/src/document/constants.ts`

### 座標変換

変換は、ビューポートの回転を含めて行う。

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

同じファイルに、可視範囲を判定する関数もある。

- `getVisibleWorldBounds`：画面に見えているワールド範囲を返す。回転が0なら、近道で計算する。回転があれば、画面の4隅をワールド座標に変換する。返すのは、その4点を囲む矩形である。
- `isInViewport`
- `boundsIntersectViewport`

## データ構造

実装場所：

- `pkgs/core/src/schema.ts`

### Document：正規化ストア

要素の実体は、すべて `document.objects` に置く。ほかの場所は、要素を ID で参照するだけである。

```typescript
interface Document {
	id: string;
	objects: Record<string, AnyArtObject>; // 全 ArtObject を ID キーで持つ正規化ストア
	layers: Layer[];
	viewport: Viewport;          // プライマリキャンバスの保存値
	files: EmbeddedFile[];       // 埋め込みファイル。画像とブラシテクスチャ
	artboards: Artboard[];
	brushPresets: BrushPreset[];
	appearancePresets?: AppearancePreset[]; // AppearancePresetRef が参照する
	timelapse?: TimelapseData;
	schemaVersion?: number;      // YYYYMMDD 形式。undefined はマイグレーション前の legacy
	hdr?: HdrSettings;           // { enabled, exposure }。exposure の単位は EV
	colorProfile?: ColorProfileSettings; // { workingSpace: "srgb" | "display-p3", proofProfile?, proofIntent? }
	rasterizationDpi?: number;   // フィルタのラスタライズ解像度。72 で 1 texel = 1 world px
	units: LengthUnit;           // "px" | "pt" | "mm" | "cm" | "in"。表示と入力だけに使う。座標は常にワールド単位
	defs?: Record<string, DefEntry>;       // キャンバスの外に置く定義。pattern と vector-brush
	references3d?: Record<string, Reference3DDef>; // 3D リファレンスのシーン。ノードは primitive、figure、mesh
}

interface Layer {
	id: string;
	name: string;
	visible: boolean;
	locked: boolean;
	opacity: number;
	blendMode?: BlendMode;
	elementIds: string[];          // document.objects への ID 参照。表示順
	transientKind?: TransientLayerKind; // "pattern-edit" | "mask-edit"。編集セッションの作業面。保存とエクスポートから除く
	ownerClientId?: string;        // transient レイヤーを持つ Yjs client ID。残骸の GC に使う
}

interface DefEntry {
	id: string;
	kind: "pattern" | "vector-brush";
	name?: string;                 // UI に出す名前
	rootElementIds: string[];      // document.objects への ID 参照。z 順
	tile?: { width: number; height: number }; // pattern のタイル矩形。def ローカル座標で、原点は中心
}
```

`Layer.elementIds` とコンテナの子 ID 配列は、ID で参照するだけである。

**編集セッション**は、普段はレイヤーの外にある内容を編集するモードである。対象は、パターンの中身とマスクの中身である。セッションは確定か取り消しで終わる。実装は2つある。

- `PaplicoPatternEdit`：pattern def の中身をワールド空間に複製して編集する。確定すると、def の中身として書き戻す。
- `PaplicoMaskEdit`：マスクの中身を、複製せずにその場で編集する。

**transient レイヤー**は、編集セッションが作る使い捨てのレイヤーである。セッションの対象をこのレイヤーに載せる。そうすると、普通のツールでそのまま編集できる。transient レイヤーは、保存にもエクスポートにも含めない。`ownerClientId` は、このレイヤーを作ったクライアントの Yjs client ID である。クラッシュしたクライアントが残したレイヤーを、これで見つけて消す。

次の2つに入った要素は、レイヤーからたどっても届かない。

- `defs` の中の要素。描画、ヒットテスト、エクスポートの対象にならない。
- オブジェクトマスクの中身。中身は、マスクの持ち主が置く。置き方は、グループが子を置くのと同じである。

`units` の定義は次のファイルにある。

- `pkgs/core/src/document/units.ts`

### 要素の型 `AnyArtObject`：9種

| 型 | `type` | 役割 |
|---|---|---|
| `Path` | `"path"` | ベジエパス。 |
| `Group` | `"group"` | 子要素をまとめるコンテナ。 |
| `CompoundPath` | `"compound-path"` | 複数のパスをブーリアン演算で1つにする。 |
| `ImageObject` | `"image"` | 埋め込み画像を置く。 |
| `TextElement` | `"text"` | テキスト。 |
| `MeshArtObject` | `"mesh"` | ケージで中身を非破壊にゆがめるコンテナ。 |
| `BlendObject` | `"blend"` | オブジェクトの間を補間した形を描く。 |
| `RepeatObject` | `"repeat"` | ソース要素を繰り返し並べる。 |
| `Reference3DElement` | `"reference3d"` | 3D シーンを参照して下絵にする。 |

各型の主なフィールドは次のとおり。

**Path**

- `segments`：パスの形。
- `pathStart?` / `pathEnd?`：分割したストロークの端で、テーパーを抑える。
- `strokeWidths?`：可変線幅のプロファイル。
- `strokeWidthsBaked?`：`strokeWidths` に、ブラシのサイズカーブの評価を焼き込んであるかどうか。
- `strokeErasure?`：消しゴムで消した境界のプロファイル。

**Group**

- `childIds`
- `collapsed?`
- `clipPathId?`：`childIds` の1つをクリップパスにする。

**CompoundPath**

- `sources: {id, op}[]`：`op` は `"union"`、`"subtract"`、`"intersect"`、`"exclude"` のどれかである。

**ImageObject**

- `fileUid`：EmbeddedFile を参照する。
- 中心座標とサイズ。
- `corners?`：自由変形した4隅。

**TextElement**

- `x` / `y`：ワールド座標の位置。
- `content`
- `defaultStyle`
- `layout`
- `axisBinding?`：パスの上に並べるか、シェイプの中に流し込むかを決める。
- `flow?`：複数の領域をつなぐ。
- `clipPathId?`

**MeshArtObject**

ケージは、中身を包む格子である。格子の頂点を動かすと、中身がゆがむ。格子の各面は Coons パッチとして補間する。

- `childIds`
- `vertices`
- `faces`：面。型 `MeshFace` は `"quad"` と `"tri"` を許す。MeshArtObject の面は quad だけである。tri を作るのはメッシュグラデーションだけである。
- `outlineOnRelease?`：解除したときに、ケージの外周をパスとして作り直す。

**BlendObject**

- `objectIds`：ブレンドのキーの並び。2つ以上。キーは、ユーザーが置いた元のオブジェクトである。隣り合う2つのキーの間に、中間形を作る。
- `renderOrder?`：キーの描画順。`objectIds` の並べ替えで表す。重なり順だけを変える。
- `spacing`：中間形の数の決め方。
  - `steps`：ペアごとに、指定した数を作る。
  - `distance`：キーの間の距離を、指定した間隔で割って数を決める。
  - `smooth`：ペアの塗りの色の差から数を決める。色の差は OKLab で測る。
- `placementEasing`：各ペアの中で、中間形の位置と形の変化に掛けるイージング。
- `appearanceEasing`：各ペアの中で、中間形のフィルタと不透明度に掛けるイージング。
- `spineSourceId?`：spine にするパス。spine は、中間形を並べる道筋である。このパスはブレンドに吸収される。
- `tiltToSpine?`：中間形を、spine の接線の向きに回す。キーは回さない。

イージング `BlendEasing` は、プリセットかカスタムである。プリセットは linear、ease-in、ease-out、ease-in-out の4つである。カスタムは `BlendEasingNode[]` で表す。曲線は、ノードを通る三次ベジエ曲線の連なりである。

**RepeatObject**

- `sourceIds`：リピートに吸収したソース要素。1つ以上。
- `mode`：`"grid"`、`"radial"`、`"mirror"` のどれか。
- `grid` / `radial` / `mirror`：各モードのパラメータ。モードを切り替えても、3つとも常に保持する。

**Reference3DElement**

- `sceneId`
- `camera`
- 中心座標とサイズ。
- `displayMode`：`"lineart"` か `"flat"`。
- `lineart?`：線を抽出するパラメータ。
- `lightDir?`：影を落とすキーライトの方向。
- `includeInExport?`

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
	isGuide?: boolean;            // undefined = false
	filters?: FilterEntry[];      // アピアランススタック。Filter かプリセット参照
	transform: ElementTransform;  // { x, y, rotation, scaleX, scaleY, skewX?, skewY? }
	mask?: ObjectMask | null;     // グレースケールマスク。マスク要素の輝度がアルファを決める
}

interface ObjectMask {
	elementIds: string[]; // マスクの中身のルート要素 ID。空なら持ち主は完全に隠れる
	enabled?: boolean;    // undefined = true
	inverted?: boolean;   // undefined = false
}
```

`isGuide` が付いた要素はガイドである。ドキュメントの描画はガイドを描かない。代わりに UI overlay の `sys/guides` が、ガイドの輪郭を細いシアンの線で描く。この線はアートボードの境界線より上、ほかの UI より下に重なる。書き出しにもガイドは入らない。ガイドのグループの中にある要素は、すべてガイドとして描く。テキスト以外のガイドは、クリックと範囲選択もこの輪郭線にだけ当たる。輪郭の作り方と描き方は次のファイルにある。

- `pkgs/core/src/document/elementGeometry/guideOutlines.ts`
- `pkgs/core/src/renderer/ui/GuideOverlay.ts`

`compositionMode` の `alpha-lock` は、透明部分の保護である。要素は、下にすでに色がある所にだけ描かれる。下のアルファは変わらない。

`ElementTransform` は、要素のローカル原点を軸にしたアフィン行列である。ローカル点 `p` は `L·p + (x, y)` に置かれる。`L` は rotation、scale、skew から作る線形部分である。

`(x, y)` が指す空間は、要素の置き場所で変わる。

- トップレベルの要素では、ワールド空間である。
- コンテナの中の要素では、コンテナのローカル空間である。グループの子も、マスクの中身も同じである。

レンダラーは、描画時にコンテナの変換を掛け合わせる。回転や拡縮の中心は、操作の間だけ存在する。操作を確定すると、コマンドがその中心を `x` と `y` に畳み込む。

### パスデータ

```typescript
interface BezierPoint {
	x: number;          // ワールドX。Y軸上向き、キャンバス中心が原点
	y: number;
	pressure?: number;  // 0.0-1.0
	tiltX?: number;     // -90〜90。単位は度
	tiltY?: number;
	twist?: number;     // ペン軸の回転 0〜359。単位は度。PointerEvent.twist
	deltaTime?: number; // ストローク開始からの累積経過ms
}

// 三次ベジエセグメント。start と end はワールド絶対座標のアンカー。
// cp1 と cp2 はアンカーからの相対オフセットで、ワールド空間のベクトル。
// 絶対座標への解決は utils/geometry/primitives/segment.ts の resolveSegment() を使う。
interface CubicBezierSegment {
	start?: BezierPoint;    // サブパスの最初のセグメントだけが持つ。以降は前のセグメントの end を始点にする
	cp1: BezierPoint;       // start アンカーからの相対オフセット
	cp2: BezierPoint;       // end アンカーからの相対オフセット
	end: BezierPoint;
	startPressure?: number; // 0-1
	endPressure?: number;
	startTiltX: number;     // 単位は度。必須
	startTiltY: number;
	endTiltX: number;
	endTiltY: number;
	startTwist?: number;    // ペン軸の回転 0〜359。単位は度
	endTwist?: number;
	startDeltaTime: number; // 単位は ms。必須
	endDeltaTime: number;
	isMoved: boolean;       // 新しいサブパスの開始。SVG の moveTo に相当
	isClosed?: boolean;     // サブパスを閉じる。SVG の Z に相当
}

interface PathSegment extends CubicBezierSegment {
	cornerRadius?: number;        // この頂点 end の角丸半径。0 か undefined なら角丸なし
	cornerSuperellipseN?: number; // 角丸の超楕円指数。2 で円弧。既定は 2。5 で iOS 風の squircle
}
```

可変線幅と消しゴムの境界は、どちらも `StrokeWidthPoint { t, side1, side2 }` の配列で表す。

- `t`：パスの全長を1としたときの位置。
- `side1` / `side2`：中心線の両側の値。

値の意味は、フィールドごとに違う。

- `strokeWidths` は、ストロークそのものの幅を変える。値は、ブラシがその点で描く幅の半分を1とした比である。中心線から各側の境界までの、符号付きのオフセットを表す。
- `strokeErasure` は、消しゴムで消した後に残る部分を表す。値は、`strokeWidths` で幅を変えた後の、描画幅の半分を1とした比である。1なら、その側は消えていない。0なら、中心線まで消えている。スタンプやテクスチャの大きさは変えずに、ストロークを切り取る。EraserTool が書き込み、StrokeWidthEditTool が手で編集する。

`strokeWidths` が描画時のブラシ設定とどう組み合わさるかは、`strokeWidthsBaked` で決まる。

- `strokeWidthsBaked` が真なら、線幅はこのプロファイルだけで決まる。描画時にサイズカーブを評価しない。
- 偽か未設定なら、描画時のサイズカーブの評価に、このプロファイルを掛け合わせる。

### カラー表現

色の成分は、すべて0.0〜1.0で表す。

```typescript
interface RGBColor { type: "rgb"; r: number; g: number; b: number; a: number }
interface HSVColor { type: "hsv"; h: number; s: number; v: number; a: number }
type Color = RGBColor | HSVColor;

interface ColorStop {
	offset: number;   // 0.0-1.0
	color: Color;
	midpoint: number; // Photoshop 式の補間の中点。0.5 で線形
}
```

**FillColor**：塗り

```typescript
type TexturedFill = LinearGradient | RadialGradient | FreeGradient | MeshGradient | PatternFill;
type FillColor = SolidColor | TexturedFill;
```

- `LinearGradient`：始点 `x1,y1`、終点 `x2,y2`、stops で表す。座標は、バウンディングボックスを0〜1とした相対値である。
- `RadialGradient`：中心 `cx,cy`、半径 `radiusX,radiusY`、`rotation`、stops で表す。座標と半径は、バウンディングボックスを0〜1とした相対値である。
- `FreeGradient`：フリーフォームのグラデーション。
  - stops は、バウンディングボックス相対の座標と `edgeCPs?` を持つ。
  - stops を Delaunay 三角形分割する。
  - できた三角形を、三角形 Coons パッチとして GPU で描く。
  - 色は OKLab で補間する。
- `MeshGradient`：自己完結型のメッシュグラデーション。vertices、faces、handles を持つ。面の分割と派生色に対応する。
- `PatternFill`：`Document.defs` の pattern を `defId` で参照する。scale、rotation、offset を持つ。タイルは、要素のバウンディングボックスに固定される。そのため、タイルは要素の変形に追従する。

**StrokeColor**：線

```typescript
type StrokeGradientMode = "within" | "along" | "across";
type StrokeColor = SolidColor | StrokeGradient | StrokePattern;
```

StrokeGradient の中に入れられるグラデーションは、LinearGradient だけである。radial、free、mesh は線に使えない。

### BlendMode：12種

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
	processor: string;        // filterCatalog に登録した processor 名
	enabled?: boolean;        // undefined = true
	opacity: number;
	blendMode: BlendMode;
	paramData: { version: string; params: T }; // バージョン付き。パラメータの移行に使う
	applyToBackdrop?: boolean; // backdrop に適用し、要素の形でマスクする
	subFilters?: Filter[];
}
type Filter<T = unknown> = Appearance<T>;

// ドキュメントのアピアランスプリセットの filters を、この位置に展開するスタックエントリ
interface AppearancePresetRef {
	type: "preset";
	uid: string;
	presetUid: string;        // Document.appearancePresets の uid
	enabled?: boolean;        // undefined = true
}
type FilterEntry = Filter | AppearancePresetRef;
```

**backdrop** は、要素の z 順の位置で、それより下にすでに合成されている画素のことである。`applyToBackdrop` を真にしたアピアランスは、要素自身の画像ではなく backdrop を加工する。加工した結果は、要素の形で切り抜く。

フィルタは、FilterHandler が実装するメソッドで3種類に分かれる。

- **ジオメトリ**：`preProcess` か `preProcessAppearance` を実装する。ラスタライズの前に形を変える。
- **ラスタ**：`postProcess` を実装する。ラスタライズした後のテクスチャを加工する。
- **パッシブ**：どちらも実装しない。`fill`、`stroke`、`content` のアピアランスがこれにあたる。

ジオメトリとラスタは、型の上で両立できない。

processor は63種を登録している。登録先は次のファイルである。

- `pkgs/core/src/renderer/filters/filterCatalog.ts`

| 分類 | processor |
|---|---|
| アピアランス | `fill`、`stroke` |
| 3D | `extrude3d`、`revolve3d`、`3d-rotate` |
| Geometry | `zigzag`、`rough`、`path-offset`、`path-union`、`stroke-outline`、`pucker-bloat`、`transform` |
| Mask | `clip-to-shape` |
| Blur / Color / Stylize / Distortion / Texture | `hk:*` シリーズほか |
| SVG フィルタプリミティブ | `svg:*` の20種 |

`content` は、カタログに登録しない構造上のアピアランスである。

### BrushSettings v2：カーブマトリクス

```typescript
type BrushEngineKind = "dab" | "ribbon" | "geometric";

interface BrushSettings {
	version: 2;
	engine: BrushEngineKind;      // dab はスタンプ。ribbon はリボンで、art と pattern を含む。geometric は幾何ストローク展開
	strokeOpacity: number;        // ストローク単位の不透明度の上限。wash 合成で使う。カーブは持たない
	paintMode: "buildup" | "wash";
	properties: Partial<Record<BrushPropertyId, BrushPropertyConfig>>; // カーブで変調できる値
	tip?: BrushTipConfig;         // dab エンジンのチップ。procedural か image。ribbon と geometric は持たない
	ribbon?: RibbonConfig;        // ribbon エンジンの設定。source、uvMode: "repeat" | "stretch"、tileScale、tileSpacing など
	stroking?: BrushStroking;     // lineCap、lineJoin、miterLimit、align?、dashArray?、dashOffset?
	grain?: GrainConfig;          // 紙目。UV はキャンバスに固定
	wetEdge?: WetEdgeConfig;      // 水彩の境界。wet.enabled の間は無視する
	mixing?: MixingConfig;        // 混色。enabled だけが有効化の条件
	wet?: WetConfig;              // ウェットレイヤー。enabled だけが有効化の条件
	backdropBlur?: BackdropBlurConfig; // 下地ぼかし。enabled だけが有効化の条件
	inputDynamics?: InputDynamicsConfig; // 入力計算そのものの設定。カーブの対象外
	randomSeed: number;
	colorMode?: BrushColorMode;   // "tinting" | "color"
}

interface BrushPropertyConfig { base: number; curves?: BrushCurve[] }
interface BrushCurve { input: BrushInputId; points: [number, number][] } // 区分線形。最大16点
```

- **Dab**：dab エンジンが、ストロークに沿って一定の間隔で押すスタンプ1つ分のこと。
- **buildup**：Dab の不透明度を、描画先に直接重ねていく。Dab が重なるほど濃くなる。
- **wash**：ストローク全体を、いったん専用のテクスチャにためる。`strokeOpacity` は、合成するときに1回だけ掛ける。そのため、ストロークが自分自身と重なっても、`strokeOpacity` より濃くならない。dab と ribbon のエンジンで使える。
- **wet edge**：水彩のように、ストロークの縁を濃くする効果。wash でためたテクスチャの縁に掛ける。

カーブの入力 `BrushInputId` は13種ある。どの入力も、0〜1に正規化してからカーブを評価する。

> `pressure` / `speedFine` / `speedGross` / `accel` / `tiltMagnitude` / `tiltAzimuth` / `twist` / `direction` / `strokeT` / `fade` / `distance` / `randomPerDab` / `randomPerStroke`

カーブで変調するプロパティ `BrushPropertyId` は24種ある。

> `size` / `ratio` / `angle` / `flow` / `spacing` / `scatterOffset` / `scatterAlong` / `hueShift` / `satShift` / `valShift` / `grainStrength` / `hardness` / `colorRate` / `alphaRate` / `smudgeLength` / `dabsPerSecond` / `wetness` / `directionality` / `grainAmount` / `absorption` / `granulation` / `bleedSoftness` / `edgeDarkening` / `edgeRoughness`

各プロパティの評価ドメイン、既定の base、クランプ範囲は、`BRUSH_PROPERTY_REGISTRY` が持つ。評価ドメインは scale か offset である。定義は次のファイルにある。

- `pkgs/core/src/brush/properties.ts`

ブラシのサイズは `properties.size.base` で決まる。単位はワールド単位である。

テクスチャのソースは `BrushArtSource` で表す。`{kind:"file"}` か `{kind:"def"}` のどちらかである。

ビルトインの ID は2つの定数にある。

- `BUILTIN_BRUSH_IDS`：ビルトインブラシ。svg、hardCircle、softCircle、pencil、airbrush、calligraphy、bacon、grainy の8つ。
- `BUILTIN_PAPER_IDS`：ビルトインの紙目テクスチャ。finePaper、coarsePaper の2つ。

### Artboard / EmbeddedFile

```typescript
interface Artboard {
	id: string; name: string;
	x: number; y: number;          // 中心のワールド座標
	width: number; height: number; // ワールド単位
	backgroundColor?: RGBColor;    // 既定は白
}

interface EmbeddedFile {
	uid: string;
	name: string;
	type: string;      // MIME タイプ
	hash: string;      // SHA-256。重複の排除に使う
	bin: Uint8Array;
}
```

## WebGPU レンダリングアーキテクチャ

描画は2つの層に分かれる。CanvasLayer がドキュメントを描く。UILayer が、選択枠などのオーバーレイを描く。

実装場所：

- `pkgs/core/src/renderer/`

```
Paplico (facade) → RenderOrchestrator → CanvasLayer (ドキュメント描画, renderer/canvas/)
                                      → UILayer     (UI オーバーレイ, renderer/ui/)
```

### RenderOrchestrator

RenderOrchestrator は、GPU デバイスと描画先を管理する。

- GPU デバイスを取得して所有する。
- `timestamp-query` が使えるなら有効にする。
- storage buffer の上限を、アダプタの上限まで引き上げる。
- canvasFormat を HDR の可否で選ぶ。`rgba16float` が使えて HDR が有効なら、`rgba16float` にする。それ以外は、`navigator.gpu.getPreferredCanvasFormat()` の値を使う。colorSpace の既定は `display-p3` である。
- 1フレームでは、CanvasLayer と UILayer を1つの command encoder に積む。`queue.submit` は1回だけ呼ぶ。
- デバイスロストから復旧する。再初期化は最大5回試す。待ち時間は1秒から始めて、試すたびに倍にする。
- `GPUTimingProfiler` が、timestamp query で GPU パスの時間を計る。

RenderOrchestrator は、複数の `CanvasTarget` を管理する。各オブジェクトを持つ単位は次のとおり。

| 持つ単位 | 持つもの |
|---|---|
| CanvasTarget ごと | CanvasLayer、UILayer、BackdropCaptureManager、RenderCacheManager |
| CanvasLayer ごと | BrushRenderer |
| 同じドキュメントを描く CanvasTarget の間で共有 | DocumentRenderScope |
| GPU デバイスで共有 | パイプライン、BrushTextureManager、FilterRenderer、TextRenderer など |

### RenderScheduler：描画戦略の選択

RenderScheduler は、そのフレームで何が変わったかを見て、描き直す範囲を決める。変わった理由は DirtyReason で受け取る。

DirtyReason は10種ある。

> `document` / `viewport` / `preview` / `selection` / `editingScope` / `cursor` / `resize` / `collaboration` / `render` / `elementMove`

`editingScope` は、編集スコープの変化である。**編集スコープ**は、ユーザーがグループなどの中に入って編集している状態である。入った要素は、スタック `editingScopeStack` に積む。ツールと選択は、スタックの一番上の要素の中だけに効く。それ以外の部分は暗く表示する。編集セッションも、始めるときにこのスタックに積む。

戦略は5種ある。判定は上から順に行う。最初に当てはまった戦略を使う。

1. `document`、`editingScope`、`resize`、`collaboration` のどれかを含む：**`full`**。すべて描き直す。
2. `elementMove` を含む：**`fullTransformOnly`**。要素のローカル bounds のキャッシュを残したまま描き直す。このキャッシュは、要素ごとに、自分の座標系での外接矩形を覚えておくものである。移動や複製では形が変わらない。そのため、キャッシュを捨てずに使える。
3. インタラクション中で、`viewport` を含む：
   - `preview` と `render` がなく、transient 要素も override もない：**`viewportBlit`**。transient 要素は、ツールのプレビューなど、そのフレームだけ足す要素である。override は、既存の要素をそのフレームだけ差し替えたものである。どちらもフレームキャッシュに入らない。そのため、どちらかがあると blit できない。ドキュメントは描かない。キャッシュした合成結果を、今のビューポートに投影し直して貼る。
   - それ以外：**`fullInteraction`**。`full` と同じパスで描き直す。
4. `selection` か `cursor` だけを含み、blit を妨げる要因がない：**`viewportBlit`**。
5. それ以外：**`overlayOnly`**。キャッシュをまとめて捨てずに描き直す。`preview`、`render`、操作が落ち着いた後の `viewport` がここに入る。

`viewportBlit` が選ばれても、CanvasLayer は次のどれかに当てはまれば通常の描画に戻す。

- 有効な compositeFrameCache がない。
- キャッシュがビューポートを覆っていない。
- HDR の露出補正か、ソフトプルーフが必要なフレームである。

ビューポートの操作が止まってから100ms待つと、フル品質で描き直す。

### フレームキャッシュ

フレームキャッシュの目的は、パン、ズーム、回転のときにドキュメントを描き直さないことである。

- `DocumentCache` が、合成結果のテクスチャを持つ。サイズは prebuf と同じである。
  - prebuf は、CanvasLayer がドキュメントを描き込む中間テクスチャである。毎フレームここに描いてから、最後の blit で canvas に写す。
  - prebuf はワールドの軸に揃っていて、回転を持たない。回転、背景、ドットグリッドは、最後の blit で付ける。
  - キャッシュできるフレームでは、prebuf を画面より各辺256px 大きく取る。この余白の中で収まるパンなら、blit だけで済む。
- `CanvasLayer.compositeFrameCache` が、そのテクスチャの有効性と bounds の情報を持つ。
- `viewportBlit` 戦略のときは、このテクスチャを今のビューポートに投影し直して貼る。

再合成するかどうかは、**要素 ID 単位**で決める。変更は、`changedElements` の upserted と deleted のセットで受け取る。再合成するのは、変更された要素と、bounds が連動する祖先と子孫だけである。

### パス描画：Sparse Strips

パスは、被覆率ラスタライザで描く。方式は Vello GPU と同じである。画素ごとに、パスがどれだけ覆っているかを面積で求めて塗る。

パス描画では、ステンシルと MSAA をどちらも廃止した。

- ステンシルは、アンチエイリアスの画質の問題で廃止した。
- MSAA は、メモリ負荷の問題で廃止した。

MSAA が残っているのは、3D フィルタのメッシュを描く `MeshPassRenderer` だけである。

描画は4段で行う。

1. **アウトライン**：`OutlineCache` が持つ。
   - 塗りは、`flattenBezierPath` で作った閉じたポリラインを使う。
   - 線は、`tessellateStroke` で作った三角形を使う。
   - どちらも、要素のローカル空間で持つ。
   - 平坦化の許容誤差は、スケールバケット `deviceScaleBucket` から決める。目安は画面上の0.25px である。
   - スケールバケットは、要素から画面への拡大率を2の累乗ごとに区切った段階である。同じ段階の中のズームなら、平坦化し直さずにアウトラインを使い回せる。
2. **strip の配置**：CPU が行う。
   - パスを、テクセル空間の線分に変換する。
   - 線分を、4×4px のタイルに分配する。
   - タイルを、高さ4px の strip にまとめる。strip は、被覆のあるタイルを横につないだ帯である。
   - タイル1つに、4つの alpha スロットを割り当てる。alpha スロットは、タイル1列分の被覆率を入れる場所である。
   - タイルとタイルの間の隙間を塗るかどうかは、帯の1行目の巻き数で決める。塗る隙間は、alpha を持たずに strip の幅だけ伸ばす。
   - 左にはみ出た線分は、左端へ射影する。こうすると巻き数が保たれる。
   - `StripCache` が strip を保持する。キーは、変換の線形部分とサブピクセル位相である。サブピクセル位相は、画面上の平行移動量の小数部分である。1/256px 単位に丸めて使う。
   - strip は、平行移動量の整数部分からの相対位置で持つ。そのため、整数テクセル単位のパンなら、そのまま再利用できる。小数部分が変わるパンでは、作り直す。
   - 実装は `pkgs/core/src/renderer/geometry/strips/` にある。
3. **被覆率**：GPU の compute shader が求める。
   - `StripCoverage` が、そのフレームで作った strip の線分とタイルを集める。フレームの submit の前に、1回の compute パスで流す。
   - `backdrop` カーネルは、帯ごとにタイルを左から順になめる。各タイルに入るときの、行ごとの巻き数を求める。
   - `coverage` カーネルは、タイルごとに非ゼロ巻き数の面積積分を行う。結果を alpha スロットに書く。
   - CPU は画素ごとの積分をしない。
   - シェーダーは `stripCoverage.wgsl.ts` にある。
4. **描画**：
   - strip は、GPU 上のページに常駐する。ページは `StripPagePool` が持つ。キャッシュに当たったフレームでは、alpha もインスタンスも書き直さない。
   - alpha ページは、4096×256 の rgba8 テクスチャである。1テクセルが1スロットで、4チャンネルがスロットの4行に当たる。
   - ページの中は前から順に詰める。予算を超えると、そのフレームで使っていない最も古いページを丸ごと再利用する。再利用されたページの strip は、次に描くときに作り直す。
   - 予算には、alpha、params、インスタンスのバイト数を合わせて数える。1フレームで使うページが予算に収まらないときは、予算を超えてページを足す。超えた分は、長く使われていないページから、フレームの開始時に破棄する。
   - `strip.wgsl` が、strip ごとの矩形をインスタンス描画する。要素ごとの色、変換、アンカーは、1回の描画につき1つの描画レコードで渡す。
   - alpha は、`paintCommon.wgsl` のペイント段に掛ける。ペイント段は、ドキュメントを描くシェーダーが共通で使う色の決定処理である。単色、グラデーション、パターン、メッシュから、画素の色を選ぶ。
   - ペイントは描画レコード側に持つ。そのため、不透明度を変えても作り直さない。

自己交差、穴、複合パスは、巻き数で処理する。

線の三角形は、向きを揃えて流し込む。そのため、結合部の重なりは1回だけ塗られる。半透明の線が交点で濃くならないのは、このためである。

along と across のストロークグラデーションでは、`params` カーネルが画素ごとの (t, u) を params ページに書く。CPU は、三角形を届くタイルへ振り分けるだけである。params ページは、alpha ページの1テクセル行に2テクセル行を持ち、各行の (t, u) を入れる。このグラデーションを使うときだけ作る。

### ストロークテッセレーション

実装場所：

- `pkgs/core/src/utils/geometry/generate/strokeTessellator.ts`

処理は次の順に進む。

1. パスをポリラインにサンプルする。
2. 可変幅やテーパーで幅が0をまたぐ位置で、サブパスを分ける。
3. 法線を計算する。
4. 本体の三角形を `[x, y]` で出力する。

lineJoin は miter、round、bevel に対応する。lineCap は butt、round、square に対応する。破線にも対応する。

三角形どうしは重なってよい。被覆率の積分が和集合を取るからである。

### ブラシストローク：3つのルート

`BrushSettings.engine` が描画のルートを決める。stroke appearance は、`processor: "stroke"` のアピアランスである。線の色とブラシ設定を持つ。ルートと stroke appearance は、呼び出し側が1回だけ解決する。呼び出し側は CanvasLayer と PathElementRenderer である。解決した結果は、`StrokeDrawInput` として描画側へ渡す。

| ルート | 描画側 | 方式 |
|---|---|---|
| `geometric` | `PathElementRenderer.renderGeometricStroke` | ストロークテッセレーションの三角形を `OutlineCache` に置く。描画は Sparse Strips で行う。 |
| `dab` | `BrushRenderer.render` が `DabRenderer.render` へ振り分ける | ベジエ曲線に沿って Dab をインスタンス描画する。先端の形は `BrushSettings.tip` で決まる。Dab の楕円率と回転は、カーブ行列の `ratio` と `angle` で決まる。 |
| `ribbon` | `RibbonRenderer.enqueue` と `flush`。即時描画は `BrushRenderer.render` | リボンの頂点を生成する。UV は stretch か、tileSpacing 付きの repeat である。バッチにためて描く唯一のルートである。 |

**Dab の評価**

- Dab ごとのサイズと不透明度は、`DabEvaluator` モジュールの `evaluateDabs` がカーブ行列から決める。
- `BoundedStampStore` が、Dab を GPU に常駐させる。そのため、パンとズームのフレームでは Dab のアップロードが0になる。

**dab ルートの追加経路**

dab ルートは、`resolveBrushRenderRequirements` の結果で追加の経路を取る。この関数は `brush/access.ts` にある。

| 要件 | 担当 | 持ち主 |
|---|---|---|
| `wet` | `WetStrokeRenderer`。ウェットレイヤーをシミュレーションする | BrushRenderer |
| `mixing` | `MixStrokeRenderer` | CanvasLayer の backdrop effect driver |
| `backdropBlur` | `BlurStrokeRenderer` | CanvasLayer の backdrop effect driver |

backdrop effect driver は、backdrop の上に要素の z 順の位置で合成する処理の差し込み口である。パスの進行は CanvasLayer が受け持つ。CanvasLayer は、各 driver を決まった時点で呼ぶ。3D 押し出しやガラスなどのフィルタも、同じ仕組みで登録する。

- `backdropBlur` が有効なら、`wet` と `mixing` は無効になる。
- `mixing` と `backdropBlur` のストロークは、下の合成結果を読む。そのため、メインパスをそこで区切る。ストロークは自分の z 順でインライン描画する。結果は `BlitLayer` として戻す。`BlitLayer` は、1回の blit で合成する描画結果である。テクスチャと、それを置く範囲を持つ。

**wash**

- `paintMode: "wash"` の dab と ribbon は、隔離テクスチャにためる。
- `strokeOpacity` は、合成時に1回だけ掛ける。
- `WashCompositor` が、この隔離テクスチャに wet edge を適用する。wet edge は縁の濃淡である。
- wet edge と `wet` は同時に使えない。

**ブラシテクスチャ**

- ビルトイン：hard circle と soft circle は、128px でプログラム生成する。pencil、airbrush、bacon、grainy は同梱画像を使う。
- カスタム：アップロード時に、長辺を 1024、768、512、256、128px のどれかの段階へ縮める。アスペクト比は保つ。実装は `pkgs/core/src/utils/embeddedFile.ts` にある。

### ブレンドモード合成

normal 以外のブレンドは、カスタム WGSL シェーダーの `COMPOSITE_SHADER` で合成する。ブレンドが normal でも、`compositionMode` が `alpha-lock` なら、このシェーダーを使う。それ以外の normal は、通常の premultiplied alpha のブレンドステートで描く。

- ブレンドモードとインデックスの対応は、`BLEND_MODE_ORDER` にある。normal が0、exclusion が11である。
- compositionMode とインデックスの対応は、`COMPOSITION_MODE_ORDER` にある。
- 合成を実行するのは、`CompositeRenderer.compositeSurfaceToCanvas` である。

シェーダーは次のファイルにある。

- `pkgs/core/src/renderer/shaders/composite.wgsl.ts`

### フィルタ実行

- **pre-filter**：`preProcess` を実装したフィルタ。ラスタライズの前に、PathSegment 配列を変形する。zigzag などがこれにあたる。実行するのは、`document/elementGeometry/preFilters.ts` の関数 `applyPreFilters` である。
- **post-filter**：`postProcess` を実装したフィルタ。要素をラスタライズしたテクスチャに、compute パスか render パスを掛ける。実行するのは `FilterRenderer.applyFilters` である。
- **backdrop**：要素の下にある合成結果にフィルタを掛ける。
  - `BackdropCaptureManager` が、prebuf からワールド領域を切り出す。
  - `BackdropEffectCoordinator` が、フレーム内の backdrop 要求をまとめて計画する。
  - `rasterScale` を指定すると、ワールドに揃えたラスタライズグリッドへ再サンプルする。こうすると、ズームやパンで backdrop フィルタの見た目が変わらない。
  - アートボードの書き出しでは、切り出した絵の下にアートボードの白い下地を敷く。書き出しは背景色を指定するので、prebuf に下地を描かない。透明背景でも、backdrop フィルタがエディタと同じ絵を映すようにするためである。この白は書き出し結果には描かない。backdrop フィルタが覆う範囲だけが不透明になる。
  - ブラーには、`BlurPyramidBuilder` が作るピラミッドを使う。解像度を半分ずつ落とした段を、最大7段持つ。σ は2.0である。2つの段の間は、分散空間で lerp する。
  - ピラミッドは、backdrop のバッチごとに1つ作る。同じバッチの要求は、そのピラミッドを共有する。

### オフスクリーン合成

- `OffscreenPresenter`：要素、グループ、クリップグループを、オフスクリーンテクスチャに焼き込む。消去マスクの適用と、テクスチャの遅延破棄も行う。
- `CompositeRenderer`：焼き上がったテクスチャを canvas に貼る。ブレンド合成もここで行う。貼り方は、通常、射影クアッド、メッシュの3つである。
- `ClipMaskAtlas`：メインパスの前に、マスクを先に描いておく。
  - クリップパスは、白いシルエットで描く。
  - オブジェクトマスクは、ソースの実際の見た目で描く。マスクとしては輝度を読む。
  - 1辺が `MAX_ATLASED_MASK_DIM` 以下のマスクは、1枚のアトラスを共有する。それより大きいマスクは、専用のテクスチャを持つ。
  - マスクは、fingerprint をキーにして、フレームをまたいでキャッシュする。fingerprint は、マスクを使い回せるかを判定する文字列である。ソースの ID、テクスチャのサイズ、ズーム、範囲、外側のマスクの fingerprint を含む。形の編集は fingerprint に入れない。変更された要素の通知で、別に捨てる。
  - ネストしたクリップグループのマスクは、外側の実効マスクを読みながら描く。そのため、1枚のテクスチャが、外側すべてのクリップとの交差を持つ。
  - メインパスでは、要素ごとにマスクをバインドする。クリップグループの子は、実効マスクを通して描画先へ直接描ける。
- `TexturePool`：オフスクリーンテクスチャを再利用するプール。予算は `min(1GiB, max(384MiB, canvasBytes×16))` である。予算を超えたら、LRU で退避する。
- `FrameUniformPool`：フレームごとの uniform バッファを、リングで再利用する。
- `RenderPlanner`：実行の前に、フレームの計画を純データで作る。GPU の参照は持たない。計画には、レイヤー合成が必要かどうかと、backdrop によるパス分割の宣言が入る。
- `FrameGraph`：パスの reads と writes から、依存グラフを作る。

### レンダーキャッシュ

`RenderCacheManager` は、10種のキャッシュを束ねる。6種は CanvasTarget ごとに持つ。残りの4種は、`DocumentRenderScope` から借りる。`DocumentRenderScope` は、同じドキュメントを描くすべての CanvasTarget で共有する。

outline と strip は、要素ごとに最大6つの variant を持つ。variant は、同じ要素から作る別々の形である。塗りと線、ジオメトリフィルタが作るコピーなどが、別の variant になる。

| キャッシュ | 持つ単位 | 中身と上限 |
|---|---|---|
| `outline` | CanvasTarget | ローカル空間のポリラインと三角形。要素あたり最大6 variant。 |
| `strip` | CanvasTarget | 被覆率の strip。要素あたり最大6 variant。 |
| `stamp` | CanvasTarget | 既定の上限は96MiB。 |
| `gradient` | CanvasTarget | GPU リソースの束。 |
| `appearance` | CanvasTarget | |
| `filteredElement` | CanvasTarget | post-filter を適用済みの要素テクスチャ。既定256MiB の LRU。ビューポートだけが変わるフレームでは、フィルタチェーンを再実行せずに再利用する。 |
| `compoundPath` | DocumentRenderScope | |
| `groupPath` | DocumentRenderScope | |
| `meshWarp` | DocumentRenderScope | |
| `blend` | DocumentRenderScope | |

### generators/

- `GradientTextureGenerator`：FreeGradient のテクスチャを作る。Delaunay 分割と、三角形 Coons パッチの compute シェーダーを使う。
- `MeshGradientTextureGenerator`：メッシュグラデーションのテクスチャを作る。キャッシュは2段である。

### UILayer

UILayer は、ツールのオーバーレイを描く。対象は、選択枠、パス編集ハンドル、ツールカーソル、マーキー、グラデーション編集、メッシュ変形、テキスト編集のキャレットなどである。

描画は3段で行う。

1. collect：`UIOverlayState.overlays` から UIPrimitive を集める。UIPrimitive は、円、矩形、線、ベジエパスなど、オーバーレイの図形を宣言的に表したものである。
2. lower：z 順に並べて、塗りの三角形とベジエストロークのインスタンス列に変換する。同じ種類が連続する区間を、run と呼ぶ。
3. draw：run ごとに1回インスタンス描画して blit する。

ストロークは、ベジエセグメントを GPU 上でクアッドに展開して描く。閉じた塗りは、CPU の earcut で三角形にする。フラグメントでのアンチエイリアスは、輪郭の辺だけに掛ける。

z 順は `OVERLAY_Z` で管理する。定義は次のファイルにある。

- `pkgs/core/src/renderer/ui/theme.ts`

## ツールアーキテクチャ

ツールは、ポインタやキーの入力を受けて、ドキュメントを変更する。すべてのツールは `Tool` インターフェースを実装する。

実装場所：

- `pkgs/core/src/tools/`

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
	onKeyDown?(e: KeyboardEvent, viewport, canvasWidth, canvasHeight): boolean; // true なら処理済み
	onWheel?(e: WheelEventData, viewport, canvasWidth, canvasHeight): boolean;  // 既定のズームとパンより先に呼ばれる
	onTouchGesture?(e: TouchGestureEventData, viewport, canvasWidth, canvasHeight): boolean; // "start" で true を返すと、2本指ジェスチャを占有する
	saveInterruptibleState?(): unknown;
	restoreFromInterrupt?(state: unknown): void;
	refreshUI?(): void;
	onSelectionHandedOver?(): void; // ツールの外で作られた選択を引き継いだとき。ツール切替で持ち越した選択や、ペーストで選択された要素
	dispose?(): void;
}
```

`PointerEventData` が持つ値は次のとおり。

- スクリーン座標
- 筆圧
- 傾き：単位は度。
- twist：ペン軸の回転。単位は度。
- pointerType
- button
- 接触サイズ
- 修飾キー
- timeStamp
- `coalesced`：`getCoalescedEvents()` のサンプル列。古い順に入る。

**ツール一覧：16種**

> `pen` / `path` / `path-edit` / `select` / `eraser` / `shape` / `text` / `gradient` / `mesh-deform` / `free-transform` / `skew` / `artboard` / `bucket-fill` / `eyedropper` / `stroke-width-edit` / `reference3d`

ツールは、エンジンを直接参照しない。操作は、すべて `ToolContext` を通す。`ToolContext` は、ツールがエンジンに頼むことをコールバックとしてまとめたものである。対象は、ドキュメントの変更、選択、ヒットテスト、スナップ、オーバーレイ、テキスト編集、ビューポートなどである。

ドキュメントの変更は、最後は `PaplicoCommands` から `YjsProvider` に届く。

## 入力処理：PaplicoUI

実装場所：

- `pkgs/core/src/ui/PaplicoUI.ts`

- **Pointer Events API**：筆圧と傾きを受け取るために使う。ジェスチャは、判別ユニオン型の state machine 1つで管理する。
- **パン**：中クリック、または Space+ドラッグで行う。ビューが回転していても正しく動く。
- **ズーム**：Ctrl+ホイールで行う。
  - macOS のトラックパッドのピンチは、ctrlKey 付きの wheel として届く。
  - カーソルの下にあるワールドの点が動かないように、位置を補正する。
  - 1回の倍率は、0.9倍か1.1倍で固定である。
  - 下限は0.1である。上限は `toolSettings.maxZoomScale` である。
  - `maxZoomScale` のエンジンの既定は640である。アプリは `appConfig.maxZoomScale` を渡す。アプリの既定は100である。設定できる範囲は1〜640である。
- **ホイール**：修飾キーがなければ、deltaX と deltaY でパンする。回転にも対応する。
- **2本指ジェスチャ**：移動量をサンプルして、pan-zoom か回転かを判別する。アクティブツールが `onTouchGesture` の `"start"` で true を返したら、そのジェスチャはツールが占有する。これを使うのは、Reference3DTool のカメラ操作である。
- **マルチフィンガータップ**：2本指タップで Undo する。3本指タップで Redo する。
- **Alt+ドラッグ**：pen と eraser のとき、ブラシサイズを変える。
- **パームリジェクション**：
  - ペンを使っている間は、タッチを拒否する。
  - 接触サイズが100px を超えるタッチも拒否する。
  - タッチで描いている途中にペンが来たら、タッチのストロークを取り消して元に戻す。
- **タッチ描画オフセット**：タッチで pen と eraser を使うときだけ、描く位置を Y 方向に60px 持ち上げる。この量はスケールで変わる。
- **GestureEvent**：macOS のトラックパッドで、回転とピンチを受け取るために使う。
  - 有効にする条件は、`GestureEvent` が存在して、`ontouchstart` が存在しないことである。
  - iPad などのタッチ端末では使わない。タッチ端末では、PointerEvent が2本の指を別々に届けるからである。

## ストローク処理：ペンツール

実装場所：

- `pkgs/core/src/utils/geometry/generate/strokeFitting.ts`
- `pkgs/core/src/brush/BrushStrokeSession.ts`
- `pkgs/core/src/tools/PenTool.ts`

入力中は、`IncrementalStrokeFitter` が、点が届くたびにフィットする。確定時は、input knot を入れる前のフィット結果を保存する。

input knot は、入力中のプレビューのために足すアンカーである。入力の時刻や筆圧が、セグメントの中で一様に変わるという見込みから外れる位置に足す。足すときは、セグメントを分割するだけである。そのため、形は変わらない。これで、プレビューの Dab が、実際の速度と筆圧を受け取れる。確定したパスには本物のアンカーだけが残る。そのため、パス編集で input knot は見えない。

`processStroke()` は、同じパイプラインを、全 raw points に一括で掛ける。こちらは、フィットの後に `simplifyFittedPath` を通す。`simplifyFittedPath` は、1本の三次曲線で表せる隣り合った区間をマージする。`processStroke()` を呼ぶのは `EraserTool` だけである。用途は、消しゴムストロークのスムージングである。

パイプラインは次の順に進む。

1. **重複除去**：連続する近い点を間引く。終点は必ず残す。
2. **スムージング**：`smoothingMethod` で方式を選ぶ。選べるのは `"smooth"`、`"pulled-string"`、`"inertia"` である。
   - `"smooth"` はガウシアンである。コーナーで区切った区間ごとに掛ける。
   - 筆圧は入力値のまま使う。
3. **コーナー検出**：コーナーでポリラインを分割する。
   - `"smooth"` は、スムージング前の入力点から検出する。
   - 他の2方式は、スムージング後の点列から、45度の閾値で検出する。
4. **フィッティング**：Schneider 法の最小二乗で、三次ベジエに当てはめる。許容誤差はズームに反比例する。
5. **セグメント出力**：cp1 と cp2 は、アンカーからの相対オフセットで持つ。筆圧、傾き、twist、deltaTime は、いちばん近いスムージング済みの点から写す。

次の内容は、devdocs のブラシシステムのページに書く。

- 接地時の筆圧補正
- 速度 EMA の接触窓
- 幅プロファイルの焼き込み
- 各段の定数と式

ページのパスは次のとおり。

- `/devdocs/brush-system`

`deltaTime` は、`pointerdown` イベントの `timeStamp` から数えた累積経過 ms である。各点に記録する。

筆圧カーブの変換は、`PaplicoUI` で行う。対象は、マウス以外のポインタだけである。

ペンツールは、ほかに2つの機能を持つ。

- 400ms の長押しで、カラーピックする。
- パースペクティブ定規の方向に、線をロックする。Alt を押すと、ロックを外せる。

## キーボードショートカット

ショートカットは2か所で登録する。

- エンジンの既定：`Paplico.ts` の `registerDefaultShortcuts()`
- アプリ層：`app/page.tsx`

キーは、物理キーの `code` で照合する。ユーザー設定で、既定を上書きできる。

**ツール切替**

| キー | ツール |
|---|---|
| `V` | 選択 |
| `P` | パス |
| `B` | ペン |
| `E` | 消しゴム |
| `A` | パス編集 |
| `T` | テキスト |
| `G` | グラデーション |
| `I` | スポイト |
| `M` | シェイプ。押すたびに、矩形、三角形、楕円、直線、星、渦巻きの順に切り替わる。ほかのツールから切り替えたときは、矩形から始まる。 |
| `L` | 楕円シェイプ |
| `Shift+W` | 線幅編集 |
| `D` | 変形ツールを順に切り替える。順番は free-transform、mesh-deform、skew である。選択がないときは、mesh-deform を飛ばす。 |

`paplico.tool.shapeRect`、`paplico.tool.freeTransform`、`paplico.tool.meshDeform`、`paplico.tool.skew` は、コマンドとして登録してある。ただし既定のキーは持たない。

**グローバル**

CtrlOrMeta は、mac では Cmd、Windows では Ctrl である。

| キー | 操作 |
|---|---|
| `CtrlOrMeta+Z` / `Shift+CtrlOrMeta+Z` | Undo / Redo |
| `CtrlOrMeta+C` / `X` / `V` | コピー / カット / ペースト |
| `CtrlOrMeta+F` / `CtrlOrMeta+B` | 前面へペースト / 背面へペースト |
| `CtrlOrMeta+G` / `Shift+CtrlOrMeta+G` | グループ化 / グループ解除 |
| `CtrlOrMeta+2` | 選択要素をロック |
| `CtrlOrMeta+3` | 選択要素を非表示 |
| `CtrlOrMeta+7` | クリッピングマスク |
| `CtrlOrMeta+[` / `CtrlOrMeta+]` | 重ね順の変更。`Alt+[` / `Alt+]` でもよい |
| `CtrlOrMeta+A` / `Shift+CtrlOrMeta+A` | 全選択 / 全選択解除 |
| `CtrlOrMeta+0` | ズームと回転のリセット |
| `Escape` | 編集スコープを1段抜ける。編集スコープの外なら、選択を解除する |
| `Shift+Escape` | 編集スコープからすべて抜ける |
| `Delete` / `Backspace` | 選択要素の削除 |
| `X` | アクティブターゲットの切替。アクティブターゲットは、色の操作の対象が線か塗りかを表す。`/` で消す色と、スポイトで拾った色を入れる先がこれで決まる |
| `Shift+X` | 線と塗りの色の入れ替え |
| `/` | アクティブ色をなしにする |
| `CtrlOrMeta+\` | スプリットビューの切替 |

**ツール固有**

- SelectTool：矢印キーで移動する。Shift を押すと10px 単位になる。
- PathTool：`Enter` で確定する。`Escape` でキャンセルする。`Backspace` で最後のアンカーを削除する。
- PathEditTool：
  - `Delete` か `Backspace` で、選択したアンカーを削除する。パスはそこで切れる。
  - `Shift+Delete` で、選択したアンカーを削除する。両隣のアンカーはつなぎ直す。
  - `CtrlOrMeta+A` で、すべてのハンドルを選択する。
- TextTool：
  - `Alt+矢印` で、カーニングと行送りを調整する。Shift を押すと大きく動く。
  - `CtrlOrMeta+Shift+>` / `<` で、文字サイズを変える。
  - `Alt+Ctrl+0` で、カーニングをリセットする。
  - 文字タッチモードは、1文字ずつ移動、回転、拡縮、傾けをするモードである。
  - 文字タッチモードで `Escape` を1回押すと、選んだ文字の選択を解除する。もう1回押すと、モードを抜ける。
- GradientTool：`Delete` か `Backspace` で、選択したストップを削除する。
- StrokeWidthEditTool：`Delete` か `Backspace` で、選択した幅ポイントを削除する。
- MeshDeformTool：`Enter` で適用する。`Delete` か `Backspace` で、選択したハンドルを削除する。
- SkewTool：`Enter` で適用する。
- Reference3DTool：
  - 編集にはモードが2つある。オブジェクトモードでは、シーンのノードを選んで動かす。ポーズモードでは、1体の人形の関節をハンドルで動かす。
  - ポーズモードでは、`1`〜`5` がプリセットポーズである。
  - `Escape` を押すたびに、1段ずつ戻る。順番は、ドラッグの取り消し、ポーズモードからオブジェクトモードへ、ノードの選択解除、編集の終了である。

## リアルタイム共同編集

各クライアントは、ローカルに Y.Doc を持つ。ドキュメントは Yjs の CRDT で同期する。編集がぶつかっても、自動で解決する。

Y.Doc の変更は、`syncYjsToValtio` で Valtio に反映する。React は、その Valtio を見て再描画する。

実装場所：

- `pkgs/core/src/collaboration/`

### 3つのバックエンドモード

`createCollaboration()` が、条件を上から順に見てモードを選ぶ。

1. `config.roomKey` がある：**`E2EECollaboration`**
   - partysocket と、自前の AES-GCM 暗号を使う。
   - Y.Doc の update と awareness の update を暗号化する。
   - 暗号化したデータは、状態を持たない PartyServer のリレーにブロードキャストさせる。リレーの実装は `relay.ts` である。
   - リレーはドキュメントを持たない。そのため、参加した人は、すでにルームにいる人からドキュメントを受け取る。
   - ドキュメントを持つ人は、オンラインでいる必要がある。ドキュメントを持つ最後の人が抜けると、そのセッションは消える。
2. `NEXT_PUBLIC_COLLAB_MODE === "cloud"`：**`PartyKitCollaboration`**
   - `y-partyserver` を使う。
   - Supabase のセッショントークンを、クエリの `token` で送る。
   - PartyServer のサーバーが、`jose` で JWT を検証する。鍵は、Supabase プロジェクトが公開する JWKS から取る。JWKS の場所は、`SUPABASE_URL` の `/auth/v1/.well-known/jwks.json` である。
   - ルームを作れるのは、ルームトークンを持つ作成者だけである。ルームトークンは、アプリの API が発行したルーム ID であることを証明する。
   - ルームトークンは、クエリの `roomToken` で送る。形式は `{roomId}:{timestamp}:{hmac_hex}` である。サーバーは、`ROOM_SIGNING_SECRET` を鍵にした HMAC-SHA256 で検証する。
   - 既存のルームに参加するゲストは、ルームトークンを持たない。トークンなしで、まだないルームに接続すると、サーバーは接続を閉じる。
3. それ以外：**`Collaboration`**。既定の local モードである。
   - `y-websocket` と、カスタムサーバー `server.mjs` を使う。
   - `maxBackoffTime` は10秒、`resyncInterval` は30秒である。BroadcastChannel は無効にする。

### ルームへの参加

`Paplico.connectCollaboration(factory, { document })` が、ルームに参加する唯一の方法である。`document` で、手元のドキュメントをどう扱うかを選ぶ。

- `"fromRemote"`：手元のドキュメントを捨てる。`resetWithFreshDoc` を呼んでから接続する。ルームの状態をそのまま使う。
- `"keepForRemote"`：手元のドキュメントを持ったまま接続する。手元のドキュメントは、ルームにマージされる。

参加して同期が終わると、ルームのドキュメントをこのクライアントのスキーマまでマイグレーションする。ルームの `meta.schemaVersion` がクライアントより新しければ、マイグレーションしない。

`"keepForRemote"` で参加したときは、同期の後に `deduplicateLayers()` を呼ぶ。ルームを作る場合も含む。Y.Array は、マージのときに両側の要素を残す。そのため、同じレイヤーが2回並ぶ。

### 招待リンクとセッションコード

招待リンクは2つの形を持つ。

```
https://<origin>/?room=<roomId>#k=<encodedKey>
paplico://join?room=<roomId>#k=<encodedKey>
```

- 下の形は、デスクトップアプリのディープリンクである。
- E2EE の鍵は、URL のフラグメントに入れる。ブラウザはフラグメントを送信しない。そのため、鍵はどのサーバーにも届かない。ページを配信するサーバーにも届かない。
- E2EE でないルームの招待リンクは、鍵を持たない。

画面に出す QR コードは、セッションコードを載せる。セッションコードは、招待リンクと同じ URL である。そのため、スマートフォンのカメラアプリで読み取ると、そのまま Paplico が開く。

- セッションコードは2種類ある。`room` はドキュメントを共有する。`companion` は、ツールの操作を別の端末に任せる。種類は URL のパスで区別する。
- Paplico は、読み取った URL の場所へは移動しない。URL からルーム ID と鍵だけを取り出して、今いる場所から接続する。コードを作った端末のアドレスは、読み取った側から正しく届くとは限らないからである。

実装場所：

- `pkgs/core/src/collaboration/inviteUrl.ts`
- `pkgs/core/src/collaboration/sessionCode.ts`

### Yjs データモデル：正規化モデル

Y.Doc のトップレベルは9本ある。

```
Y.Doc
├─ "layers"       (Y.Array<Y.Map>)  レイヤー。elementIds は Y.Array<string> の ID 順序リスト
├─ "objects"      (Y.Map<Y.Map>)    全 ArtObject のフラットマップ。id から要素の Y.Map を引く
├─ "meta"         (Y.Map)           ドキュメント ID、スキーマバージョン、HDR、カラープロファイル、ラスタライズ DPI、長さ単位
├─ "artboards"    (Y.Array)
├─ "files"        (Y.Map)           EmbeddedFile
├─ "brushPresets" (Y.Map<Y.Map>)
├─ "appearancePresets" (Y.Map<Y.Map>)
├─ "defs"         (Y.Map<Y.Map>)
└─ "references3d" (Y.Map<Y.Map>)
```

- local サーバーは、新しいルームを作るときだけ、meta に `id`、`name`、`ownerId` を書く。
- 要素の Y.Map のフィールドは、3系統に分かれる。
  - スカラーを直接書くものは `SCALAR_FIELDS` に並べる。
  - JSON 文字列で書くものは `JSON_FIELDS` に並べる。
  - バイナリで書くものは `BINARY_FIELDS` に並べる。パスの `segments` と `strokeWidths` がこれに当たる。
  - どれにもないキーは、`updateElement` で黙って捨てられる。そのため、schema を拡張したら、必ずどれかに追加する。
  - 追加漏れは、`yjsFieldCoverage.test.ts` が検出する。
- `segments` と `strokeWidths` は、`Float64Array` を `Uint8Array` として書く。
  - 長いストロークでは、アンカーを 1 個動かすだけでもフィールド全体を書き直す。バイナリは JSON 文字列より小さく、読み書きも速い。
  - 先頭の 1 要素は、フォーマットのバージョンである。
  - その後ろに、配列の 1 要素ごとに固定長のレコードが続く。
  - レコードは、スキーマの全フィールドに 1 つずつ枠を持つ。`BezierPoint` の任意フィールドも、`start`、`cp1`、`cp2`、`end` のそれぞれに枠がある。
  - 値のない任意フィールドは NaN にする。これで、値がないことと 0 を区別できる。
  - 真偽値は 0 と 1 にする。
  - 符号化と復号は、`pathFieldCodec.ts` だけが行う。
  - 読むときは、以前の版が書いた JSON 文字列も受け付ける。タイムラプスの記録と共同編集のルームに、JSON 文字列が残っているからである。
  - この版より前のアプリは、このバイナリを読めない。
- **viewport は Y.Doc に入れない。** ローカル状態の `RendererState.viewports` で管理する。キーは CanvasTarget の ID である。
- ドキュメントを差し替えるときは、`YjsProvider.resetWithFreshDoc()` を通す。
  - 差し替えにあたるのは、既存ルームへの参加、`replaceDocument`、`loadYjsState` である。
  - このとき、Y.Doc と UndoManager を作り直す。
  - provider への `update` 購読は引き継がれる。古い `ydoc` に直接付けたリスナーは引き継がれない。

### Undo/Redo

- Yjs の `UndoManager` を使う。追跡するルートは `[yObjects, yLayers, yArtboards, yDefs, yReferences3d, yAppearancePresets]` である。`captureTimeout` は500ms である。
- `createSessionUndoManager(trackedOrigins)` は、編集セッション専用の UndoManager を作る。
  - origin は、Yjs のトランザクションに付けるラベルである。UndoManager は、追跡対象の origin が付いたトランザクションだけを記録する。
  - セッション用の UndoManager は、指定した origin の操作だけを追跡する。メインの UndoManager は、その操作を記録しない。
  - 追跡するルートは `[yObjects, yLayers, yArtboards, yDefs]` である。
  - 使っているのは `PaplicoPatternEdit` である。
- UndoManager のイベントは、次のように使う。
  - `stack-item-added`：保留中のメタを付ける。`canUndo` と `canRedo` を更新する。
  - `stack-item-updated`：保留中のメタを付ける。
  - `stack-item-popped`：保存したメタを `onUndoStackMetaPopped` に渡す。パス編集の選択は、ここで復元する。`canUndo` と `canRedo` を更新する。
- `stopUndoCapture()` で、グルーピングを打ち切る。これで、1回のドラッグが1つの undo ステップになる。
- **規約：ドキュメントの変更は、すべて YjsProvider のメソッドを通す。** Valtio のドキュメントデータを、直接書き換えてはいけない。

データは次の向きに流れる。逆向き、つまり Valtio から Yjs への同期はない。

```
User action → Tool → PaplicoCommands → YjsProvider → Y.Doc update → syncYjsToValtio → Valtio → React 再レンダリング
```

### Awareness API

共有するフィールドは3つある。

- `user: { id, name, color }`
- `readonly: boolean`
- `cursor: { x, y } | null`：ワールド座標。

カーソルは、pointermove のたびに更新する。専用の間引きはしない。差分の送信は、Yjs Awareness に任せる。

### ローカルエコー

入力中のプレビューには、Awareness を使わない。Yjs に流れない、ローカルの Valtio state を使う。

- `transientElements`：描いている途中のストロークのプレビュー。sentinel ID は `__pen_preview__` である。確定したらクリアして、`commands.addPath` を呼ぶ。
- `elementOverrides`：ドラッグ中に要素を差し替えるプレビュー。commit したらクリアして、`commands.updateElement` を呼ぶ。

### local サーバー：server.mjs

- Next.js のカスタム HTTPS サーバーである。
- `/api/collaboration` の下への upgrade を、自前の `setupWSConnection` に流す。これは、y-websocket v2 の bin/utils をインラインに移植したものである。y-websocket と互換がある。
- ルームはメモリで管理する。roomId から WSSharedDoc を引く。
- オーナーと readonly を管理する。
- 制御メッセージの Kick と CloseRoom を扱う。
- `GET /api/collaboration/{roomId}/meta` を提供する。
- 起動時に、PID を `pap.lock` に書く。SIGINT で消す。

## ステート管理

すべてのリアクティブステートは、Valtio で管理する。

**`RendererState`**

エンジンの状態を一括で持つ。

- 持つもの：document、currentLayerId、canUndo と canRedo、elementOverrides と transientElements、選択状態、uiOverlayState、編集セッション、editingScopeStack、viewports など。
- elementOverrides と transientElements は、`ref()` で包む。Valtio のプロキシにしないためである。
- 外部には、読み取り専用の `PublicUIState` として公開する。`Paplico.uiState` から読める。

生成と型の場所は次のとおり。

- 生成：`pkgs/core/src/renderer/rendererState.ts`
- 型：`pkgs/core/src/renderer/types.ts`

**`stores/`**

アプリの状態を持つ。

- `uiStore`：パネルの開閉、アクティブターゲットなど。
- `documentStore`：Dexie と IndexedDB で、ドキュメントを読み書きする。
- `documentSessionStore`
- `sessionStore`：再接続の情報を、sessionStorage の `paplico:reconnectInfo` に持つ。
- `autoSave`
- `notificationStore`

アプリの設定 `appConfig` は、次のファイルにある。

- `pkgs/web/src/hooks/useAppConfig.ts`

## ファイル入出力

### papf 形式

`.papf` ファイルは、2層でできている。外側は PDF コンテナである。内側に papf バイト列を格納する。

実装場所：

- `pkgs/core/src/io/papf/`

詳細：

- `docs/papf-format.md`

**外側：PDF コンテナ**

- ディスク上のファイルは、正しい PDF である。
- 目的は、ファイルビューアやファイル共有サービスで、中身をプレビューできるようにすることである。印刷は、今のところ想定していない。
- アートボードごとに、JPEG プレビューのページを1枚持つ。
- papf バイト列は、Catalog の `/PieceInfo /Paplico /Private` ストリームに、そのまま格納する。
- 読み込み時は、先頭のマジックで、PDF か裸の papf バイト列かを判別する。
- IndexedDB への自動保存は、PDF に包まない。
- 実装は `pdfContainer.ts` と `@cantoo/pdf-lib` である。

**内側：papf バイト列**

PAPF は、Paplico Packed Format v1 の略である。リトルエンディアンの、セクション型バイナリコンテナである。

```
ファイルヘッダ "PAPF" (32B: magic, formatMajor=1, formatMinor=0, fileFlags, createdAt)
├─ セクション "PSEC" × n
│    META 0x0001  CBOR のドキュメントメタ
│    FILE 0x0002  埋め込みファイルの生バイナリ
│    TMLH 0x0003  タイムラプスのマニフェスト
│    TMLB 0x0004  タイムラプスのブロック
│    TOC  0x00ff  目次。最後のセクション
└─ フッタ "PEND" (40B: TOC オフセット・サイズ、ファイルサイズ、TOC CRC32)
```

- 圧縮コーデックは、None と Deflate である。Deflate には、ブラウザの CompressionStream を使う。もともと圧縮済みの MIME タイプには、None を使う。
- META、TMLH、TMLB のペイロードは CBOR である。FILE は生のバイト列である。TOC は固定のバイナリレイアウトである。
- 保存時に GC を行う。レイヤーと defs から届かない ArtObject を取り除く。どこからも参照されない files も取り除く。

### マイグレーション

古いスキーマで書かれたドキュメントを、今のスキーマに合わせる。

実装場所：

- `pkgs/core/src/io/migrations/`

```typescript
interface Migration {
	version: number;     // この移行が到達するスキーマバージョン。YYYYMMDD 形式
	wholeDocument?: true; // ほかの要素を読んで書き換える移行に付ける。ドキュメント全体にしか適用できない
	migrate(doc: Document, context?: MigrationContext): void; // doc をその場で書き換える
}
```

- `migrations` 配列に登録した移行を、バージョンの古い順に適用する。
- 適用した後に、`doc.schemaVersion` を更新する。
- ファイル名は `YYYYMMDD_mig_*.ts` とする。

マイグレーションは、3つの経路で動く。schema を変えるときは、3つとも通ることを確かめる。

- **ファイル**：papf を読み込むときに適用する。
- **共同編集のルーム**：参加して同期した後に、`YjsProvider.migrateRoomSchema` が適用する。書き換えは1つのトランザクションで行う。このトランザクションは Undo の履歴に残らない。
- **クリップボード**：Paplico の要素を貼り付けるときに、`decodeElementsPayload` が適用する。要素だけを入れた仮のドキュメントを作って、そこに移行を掛ける。

ルームとクリップボードのデータは、バージョンを持たないことがある。その場合は、`UNVERSIONED_SCHEMA_BASELINE` の 20260927 で書かれたものとみなす。クライアントより新しいバージョンで書かれたデータは、マイグレーションせずに拒否する。

### エクスポート

公開する入口：

- `@paplico/core/export`

実装場所：

- `pkgs/core/src/io/export/`

各形式は、`IExporter` を実装したクラスである。形式ごとの設定は、コンストラクタで受け取る。

書き出しは、`paplico.exportArtboard(exporter, artboardId)` で行う。`Paplico` は、描画機能とドキュメントを `ExportContext` にまとめて渡す。そのため、アプリの外で実装した `IExporter` も、同じ入口で使える。

- **PNG / JPEG**：`PNGExporter` / `JPEGExporter`。ICC プロファイルを埋め込める。
- **AVIF HDR**：`AvifHdrExporter`。
  - 常に 10bit、4:4:4 で書き出す。
  - 伝達特性は、ドキュメントの HDR が有効なら PQ である。無効なら sRGB である。
  - 色域は、作業色空間が sRGB なら BT.709 である。それ以外は Display-P3 である。
  - エンコードには `@paplico/avif-hdr` を使う。これは Pure TypeScript のエンコーダである。WASM にもネイティブにも依存しない。
- **PSD**：`PSDExporter`。`ag-psd` の `writePsd` で書く。ICC は image resource 1039 に入れる。
- **TIFF**：`TIFFExporter`。自前の `tiffWriter` で書く。CMYK と RGB の変換と、レンダリングインテントの指定に対応する。
- **SVG**：`SVGExporter`。
  - SVG で表せる要素は、ベクターのマークアップで出力する。
  - テキストは、常にアウトライン化する。
  - ラスタライズが必要な要素は、z 順で連続するまとまりごとに描く。解像度は、ドキュメントのラスタライズ DPI である。描いた結果は、PNG の data URL として埋め込む。
- **MP4**：タイムラプスの書き出しは、`IExporter` を使わない。`Paplico.createTimelapseExporter` で作る `TimelapseExporter` が担う。詳しくはタイムラプスの節に書く。

## タイポグラフィ

実装場所：

- `pkgs/core/src/typography/`

**FontManager**

- Paplico インスタンスごとに1つ持つ。`paplico.fonts` から使う。
- `Paplico.create` の `fontLoaders` で渡された `FontLoader` を束ねる。
- どのローダーで読むかは、`FontSource.loaderId` で決める。
- アプリは、`GoogleFontsLoader` と `LocalFontsLoader` を登録する。

ローカルフォントの取得は、環境ごとに実装が分かれる。

- ブラウザ：`pkgs/core/src/infra/localfonts.web.ts`
- Tauri：`pkgs/web/src/infra/localfonts.tauri.ts`

**TextLayoutEngine**

レイアウトは、shape、break、place の3段で行う。対応する機能は次のとおり。

- 横書きと縦書き
- 禁則処理つきの行折り返し
- ボックスの制約と、あふれたときの処理。処理は hidden、ellipsis、visible から選ぶ。
- 縦中横
- 文字単位のカーニング
- **パス上配置**：`axisBinding.mode === "onPath"` のとき。開いたパスを軸にして、グリフを並べる。パスの全長を超えた分は打ち切る。
- **シェイプ内流し込み**：`"inShape"` のとき。閉じたパスの内側へ、スキャンライン方式で流し込む。内外判定は even-odd である。穴にも対応する。
- **複数リージョン連結**：`layoutFlow` と `TextElement.flow` で行う。あふれたテキストを、次の TextElement へ流す。

**可変フォント軸**

軸の値は、`TextStyle.fontVariationSettings` に持つ。軸タグから値への対応である。描画時の座標は、`fonts/fontVariations.ts` の `resolveFontVariations` が決める。

- `wght` は `fontWeight` を使う。
- 値の指定がない `ital` は、`fontStyle` を使う。
- その他の軸は、指定値を使う。指定がなければ、軸の既定値を使う。
- どの軸も、その軸の min〜max に収める。

**TextRenderer**

グリフのベジエパスを、通常のパス描画パイプラインに渡して描く。

## タイムラプス

実装場所：

- `pkgs/core/src/timelapse/`

**TimelapseRecorder**

`YjsProvider` の `update` イベントで届く Yjs update を記録する。

- 各エントリは `TimelapseEntry { t, u }` である。`t` は相対タイムスタンプである。
- papf を import したときは、既存のデータの後ろに記録を続ける。
- 直前のエントリと同じオブジェクト群への更新は、1つのエントリに畳む。条件は、そのエントリの開始から300ms 以内に届くことである。畳むには `Y.mergeUpdates` を使う。
- 削除と、別のオブジェクトへの更新は、エントリを閉じる。

`TimelapseData` の `version` は2である。`entries` のほかに、3つのデータを持つ。

- `packedBlocks`：ファイルに保存されたままの、圧縮されたブロック。`entries` より前のエントリを持つ。展開した記録はドキュメントの何倍も大きくなることがある。そのため、読み込みでは最後のブロックだけを展開する。再生を始めるときに `unpackTimelapse` で全体を展開する。保存では、そのまま書き戻す。

- `index.rects`：エントリごとに変わったワールド矩形。アートボードで絞り込むときに使う。`null` は、範囲が分からないことを表す。
- `baselines`：ドキュメントを差し替えた位置。差し替え時は、ドキュメント全体から自己完結した update を作る。それを baseline として追記する。再生側は、その位置で replay ドキュメントを作り直す。

**TimelapsePlayer**

update を順に適用して再生する。

- パス描画のアニメーション、キーフレームのスナップショット、アートボードの絞り込みに対応する。
- 再生速度は、任意の値を受け付ける。UI が選ばせるのは、1、2、5、10倍である。
- 冒頭では、完成形を400ms 見せる。次に、300ms で白へフェードする。そのあと、先頭から再生する。

**TimelapseExporter**

WebCodecs の VideoEncoder と MediaBunny で、MP4 に書き出す。冒頭の演出は、TimelapsePlayer と同じである。

## Syrup 自動化スクリプティング

ユーザー自動化は、Syrup で書く。拡張子は `.syrup` である。Syrup は Swift 風の静的型付き言語である。JavaScript にコンパイルされる。

言語リファレンス：

- `pkgs/syrup/specification.md`

### pkgs/syrup：Paplico に依存しない

```
syntax/ (chevrotain パーサ → AST) → checker/ (双方向型検査) → emit/ (JS 出力)
host/ScriptHost   — compile / analyze / runTests、パッケージ登録、createWorkerRunner
runner/           — broker (メインスレッド: 実バインディング + handle テーブル) ⇄ executor (Worker)
service/, monaco/ — LanguageService (補完・ホバー・シグネチャ・定義) + エディタ統合
```

- スクリプトは Web Worker で実行する。Worker が持つのは、コンパイル済みのコードだけである。
- ホストの呼び出しは、すべて `__host` RPC になる。応答するのは、メインスレッドの `RunnerBroker` である。
- ホストのオブジェクトは、handle として Worker の境界を越える。handle の実装は `runner/marshal.ts` にある。
- スクリプトから見えるのはプロキシである。エンジンの生のオブジェクトではない。
- タイムアウトの既定は60秒である。超えたら Worker を terminate する。

### Paplico 側の統合：pkgs/web/src

- `scripting/api.ts`：スクリプトに見せる Syrup の型宣言 `PAPLICO_SCRIPTING_DECLARATIONS` と、`registerPaplicoScriptingApi` を持つ。
  - **宣言とランタイムバインディングは、必ずここで同時に追加する。** 片方だけ追加すると、型検査と実行時の挙動が食い違う。
- `scripting/dom.ts`：`PaplicoAutomationDom`。バインディングを、`PaplicoCommands` と `PaplicoSelection` の呼び出しに変える。
  - スクリプトからのドキュメント変更も、コマンドを通る。コマンドは YjsProvider を通る。そのため、Undo が普通に効く。
  - スクリプト1回の変更は、`begin()` と `commit()` の間にためる。`commit()` で、ためた変更を1つの `transact` にまとめて書く。前後で `stopUndoCapture()` を呼ぶ。そのため、1回の実行が1つの Undo ステップになる。
- `scripting/runtime.ts`：`createPaplicoAutomationRuntime`。
  - 同時に実行するスクリプトは1本である。
  - タイムアウトは60秒である。
  - `stdout` と `prompt` のコールバックは、UI から渡す。
- `automation/`：スクリプトカタログ。
  - `builtins.ts`：読み取り専用のサンプル6本。
  - `repository.ts`：localStorage に置くユーザースクリプト。管理できるのは、`canManageUserScripts` が真の環境だけである。つまり Tauri ビルドだけである。
  - UI は `dialogs/AutomationDialog.tsx` である。
  - ファイルアクセスは `infra/automationFileSystem.ts` を通す。

## Tauri デスクトップ

`pkgs/desktop/` は、Next.js の静的出力を Tauri v2 で包む。静的出力は `pkgs/web/out` にある。iOS もターゲットにある。

**実行環境の判定**

実行環境の分岐には `IS_TAURI_ENV` を使う。定義は次のファイルにある。

- `pkgs/web/src/utils/platform.ts`

値の決まり方は、ビルドの種類で違う。

- 本番ビルド：ビルド時の `process.env.IS_TAURI_ENV === "1"` で決まる。
- 開発時：UserAgent に `"PaplicoDesktop"` が含まれるかで決まる。Tauri は、この UserAgent を設定する。

**Rust 側**

- プラグイン：fs、dialog、sql、deep-link、opener、oauth、system-fonts、safe-area-insets-css など。
- コマンド：自動化用のファイルアクセスコマンド群 `automation_*` と、フォントを読む `load_font_data` と `read_font_range`。
- ネイティブメニュー：メニューから `app:reload` イベントを送る。

**`.papf` のファイル関連付け**

関連付けは、`tauri.conf.json` の `fileAssociations` で行う。

- macOS には、UTI `la.hanak.paplico.document` を書き出す。この UTI は `com.adobe.pdf` に準拠すると宣言する。そのため、Quick Look が PDF コンテナのプレビューページを表示する。
- Linux では、deb パッケージに shared-mime-info の XML を入れる。

OS から渡されたパスは、`launch_files.rs` が受け取る。

- macOS では `RunEvent::Opened` で届く。Windows と Linux では、起動引数で届く。
- webview が購読を始める前に届いたパスは、`take_launch_files` コマンドで渡す。
- 購読を始めた後は、`paplico:open-files` イベントで渡す。
- `TauriInit.tsx` が、これを DOM イベントの `tauri-open-files` として dispatch し直す。

**プラットフォーム依存コードの隔離**

プラットフォームに依存するコードは、`infra/` に隔離する。

- `pkgs/core/src/infra/`：エンジンが必要とするもの。クリップボードとローカルフォント。
- `pkgs/web/src/infra/`：アプリが必要とするもの。filesystem、IndexedDB、Supabase、システムの ICC プロファイル。

実装は、`.web.ts` と `.tauri.ts` のファイル分割か、dynamic import で切り替える。

**OAuth**

OAuth 認証は、システムのブラウザで行う。トークンをアプリへ渡す経路は2つある。

- dev：localhost へのコールバックを使う。
- 本番：`paplico://` ディープリンクを使う。

## エラーハンドリングとリカバリー

- **WebGPU デバイスロスト**：`device.lost` を監視する。デバイスロストが起きたら、デバイスを取り直して、レンダラーを初期化し直す。試すのは最大5回である。待ち時間は1秒から始めて、試すたびに倍にする。
- **WebSocket 切断**：
  - local モードは、y-websocket の指数バックオフで再接続する。`maxBackoffTime` は10秒に上書きする。30秒ごとに再同期もする。
  - E2EE モードは、同期のタイムアウトを15秒とする。超えたら `syncTimeout` イベントを発火する。
- **再接続の判定**：sessionStorage の `paplico:reconnectInfo` を使う。
  - local と cloud のルームでは、サーバーの meta の documentId が一致したら、再接続とみなす。
  - E2EE のルームは、meta を持たない。そのため、sessionStorage の記録だけで判断する。
  - meta の `schemaVersion` がクライアントより新しいルームには、参加しない。
- **重複レイヤーの統合**：`"keepForRemote"` で参加したときは、同期の後に `deduplicateLayers()` を呼ぶ。詳しくは「ルームへの参加」の節に書く。

## パフォーマンス最適化の要点

1. **レンダリング**
   - ビューポートカリング：見えている範囲だけを描く。
   - 要素 ID 単位のダーティ追跡と、差分の再合成。
   - compositeFrameCache の blit：ビューポートの操作中と、選択やカーソルの更新時に使う。戦略名は `viewportBlit` である。
   - GPU リソースのプールとリングでの再利用：TexturePool、FrameUniformPool、BrushFrameBuffers。
   - 常駐スタンプ：BoundedStampStore。
2. **データ転送**
   - papf の Deflate 圧縮と CBOR。
   - Yjs の差分同期。変更した分だけを送る。
   - Undo のキャプチャ窓500ms と、`batchUpdateElements` による1トランザクション化。
3. **共同編集**
   - ローカルエコー：transientElements と elementOverrides で、すぐに画面に反映する。
   - Awareness による、軽いカーソル共有。
