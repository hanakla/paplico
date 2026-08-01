# Renderer Architecture

Paplico の WebGPU レンダリングパイプラインのアーキテクチャドキュメント。

## キャッシュ・プール一覧

レンダラー内部で使用されるキャッシュとバッファプールの一覧。

### テクスチャキャッシュ

| 名前 | 所在 | キー | 説明 | 無効化タイミング |
|---|---|---|---|---|
| ドキュメントキャッシュ | CanvasLayer | なし (単一) | ドキュメント全体をオーバーサイズ (canvas の 2 倍) テクスチャに描画した結果。pan 時にドキュメント再描画をスキップし、blit だけで済ませるために使う | strategy が "full" / zoom・rotation 変更 / viewport がマージン外に到達 |
| 画像テクスチャキャッシュ | CanvasLayer | 画像ファイル ID | 埋め込み画像 (EmbeddedFile) をデコードして GPU テクスチャに変換した結果 | 未使用の画像が削除されたとき |
| ブラシテクスチャキャッシュ | BrushTextureManager | ブラシ種別 | ブラシスタンプのソース画像テクスチャ。ブラシ種別ごとに 1 つ | 明示的な destroy 時 |
| グラデーションテクスチャキャッシュ | GradientTextureGenerator | グラデーション定義ハッシュ | CPU で生成したグラデーション画像。同じ定義なら再利用する。LRU で最大数を制限し、2 フレーム未使用で evict | グラデーション定義 (CP 位置含む) の変更 / フレーム開始時の evict |
| テキストパスキャッシュ | CanvasLayer | テキスト要素のハッシュ | テキスト要素からグリフパスへの変換結果。フォント読み込み完了後にキャッシュされ、再変換を避ける | テキスト内容・スタイル・フォントの変更 |
| textureCache (未使用) | CanvasLayer | — | 現在どこからも参照されていないデッドコード。destroy 時にクリーンアップされるのみ | — |

### バッファプール

| 名前 | 所在 | 説明 | ライフサイクル |
|---|---|---|---|
| グラデーションバッファプール | CanvasLayer | グラデーションフィル描画用の uniform / stops / vertex バッファ。フレームごとにインデックスをリセットし、既存バッファを再利用する | フレーム開始でインデックスリセット。不足時に追加確保 (grow-only) |
| スタンプバッファプール | BrushStrokeRenderer | ブラシスタンプの instance storage バッファ。パスごとに 1 つ使用し、サイズ不足時のみ再確保 | フレーム開始でインデックスリセット。不足時に grow |
| グラデーション uniform プール | BrushStrokeRenderer | ストロークグラデーションの uniform バッファ | 同上 |
| カラーストッププール | BrushStrokeRenderer | グラデーションカラーストップの storage バッファ | 同上 |

---

## ファイル構成

| コンポーネント | ファイル |
|---|---|
| メインレンダラー | `renderer/WebGPURenderer2.ts` |
| レンダースケジューラー | `renderer/RenderScheduler.ts` |
| キャンバスレイヤー | `renderer/CanvasLayer.ts` |
| UI レイヤー | `renderer/UILayer.ts` |
| ブラシストローク | `renderer/BrushStrokeRenderer.ts` |
| スタンプ生成 | `renderer/StampGenerator.ts` |
| テクスチャ管理 | `renderer/BrushTextureManager.ts` |
| プリフィルター | `renderer/PreFilterRenderer.ts` |
| ポストフィルター | `renderer/FilterRenderer.ts` |
| ブラーフィルター | `renderer/filters/BlurFilterProcessor.ts` |
| FrostGlass フィルター | `renderer/filters/FrostGlassFilterProcessor.ts` |
| Backdrop キャプチャ | `renderer/BackdropCaptureManager.ts` |
| グラデーション生成 | `renderer/GradientTextureGenerator.ts` |

---

## RenderStrategy 決定フロー

```mermaid
sequenceDiagram
    participant User as ユーザー操作
    participant S as RenderScheduler

    User->>S: ストローク描画中 → markDirty("preview")
    Note over S: "preview" ∉ FULL_RENDER_REASONS → "overlay-only"

    User->>S: pan / zoom → markDirty("viewport")
    Note over S: "viewport" ∉ FULL_RENDER_REASONS → "overlay-only"
    Note over S: CanvasLayer.isCacheValidForViewport() が再構築要否を判定

    User->>S: 選択変更 → markDirty("selection")
    Note over S: "selection" ∉ FULL_RENDER_REASONS → "overlay-only"

    User->>S: カーソル移動 → markDirty("cursor")
    Note over S: "cursor" ∉ FULL_RENDER_REASONS → "overlay-only"

    User->>S: 要素追加/変更 → markDirty("document")
    Note over S: "document" ∈ FULL_RENDER_REASONS → "full"

    User->>S: リサイズ → markDirty("resize")
    Note over S: "resize" ∈ FULL_RENDER_REASONS → "full"

    User->>S: Yjs 同期 → markDirty("collaboration")
    Note over S: "collaboration" ∈ FULL_RENDER_REASONS → "full"
```

1フレーム内で複数の `markDirty()` が呼ばれた場合、`requestAnimationFrame` で合体される。1つでも FULL_RENDER_REASONS に含まれる reason があれば `"full"`、なければ `"overlay-only"` になる。

---

## フレームレンダリング全体

```mermaid
sequenceDiagram
    participant S as RenderScheduler
    participant P as Paplico
    participant R as WebGPURenderer2
    participant CL as CanvasLayer
    participant UL as UILayer
    participant GPU as GPUQueue

    Note over S: requestAnimationFrame コールバック発火
    S->>S: resolveStrategy() → strategy
    S->>P: renderCallback(strategy)
    P->>R: render(document, previewPath, selectionUI, ..., strategy)

    R->>R: canvas のサイズを取得
    R->>CL: updateViewport(viewport, width, height)
    Note over CL: viewport と canvas サイズを保存
    Note over CL: 共有 uniform buffer にビューポート情報を書き込み
    Note over CL: ステンシルテクスチャのサイズを確保
    R->>UL: updateViewport(viewport, width, height)

    R->>R: スワップチェーンからフレームテクスチャを取得
    R->>R: メインコマンドエンコーダーを作成

    R->>CL: render(encoder, textureView, ..., strategy)
    Note over CL: strategy が "full" またはキャッシュが無効ならドキュメント再描画が必要

    alt ドキュメント再描画が必要
        Note over CL: --- Document Cache Render 開始 ---
        CL->>CL: オーバーサイズキャッシュテクスチャを確保
        Note over CL: canvas サイズの 2 倍で作成 (デバイス上限でクランプ)
        Note over CL: サイズ変更がなければ既存テクスチャを再利用

        Note over CL: canvas サイズをオーバーサイズに一時差し替え
        CL->>CL: uniform buffer をオーバーサイズ用に書き換え
        CL->>CL: ステンシルテクスチャをオーバーサイズに拡大

        CL->>CL: 専用コマンドエンコーダーを作成
        CL->>CL: renderDocument でドキュメント全体を描画
        Note over CL: → renderDocument の詳細は次のセクションを参照

        CL->>GPU: 専用エンコーダーを即座に submit
        Note over CL,GPU: 共有 uniform buffer の値が submit 時点で確定する

        CL->>CL: キャッシュ有効フラグを立てる
        CL->>CL: キャッシュが覆うワールド領域を記録
        Note over CL: viewport 中心からオーバーサイズ分の半径で矩形を計算
        Note over CL: zoom と rotation も記録

        Note over CL: canvas サイズ・uniform・ステンシルを元に復元
        Note over CL: submit 済みなので stencil の破棄/再作成は安全
        Note over CL: --- Document Cache Render 完了 ---
    end

    CL->>CL: キャッシュテクスチャをメインキャンバスに blit
    Note over CL: キャッシュ構築時に記録したワールド領域を blit bounds として使用
    Note over CL: blit shader がワールド座標を現在の viewport で NDC 変換
    Note over CL: 画面外部分は NDC クリッピングで切り落とし

    opt プレビューパスあり
        CL->>CL: プレビューパスをメインキャンバスに重ね描画
    end

    R->>UL: UI レイヤーを描画
    Note over UL: 選択・パス編集・カーソル・マーキー・アートボード・ホバー・スナップライン・グラデーション編集

    R->>GPU: メインエンコーダーを submit
```

---

## ドキュメントキャッシュの有効性判定 (isCacheValidForViewport)

```mermaid
sequenceDiagram
    participant CL as CanvasLayer

    Note over CL: キャッシュが未構築 → INVALID
    Note over CL: zoom 不一致 → INVALID (解像度が変わるため)
    Note over CL: rotation 不一致 → INVALID (角度が変わるため)

    Note over CL: 現在の viewport の可視ワールド領域を計算
    Note over CL: キャッシュ領域の端から 25% をマージンとして差し引く

    alt viewport がマージン内に収まっている
        Note over CL: VALID → キャッシュをそのまま blit
    else viewport がマージンに到達
        Note over CL: INVALID → oversize cache を再構築
    end
```

---

## renderDocument 内部フロー

```mermaid
sequenceDiagram
    participant CL as CanvasLayer

    CL->>CL: グラデーションテクスチャとブラシバッファプールをフレーム開始状態にリセット

    CL->>CL: ドキュメントのファイル参照と編集グループを保存
    CL->>CL: 全オブジェクトの ID→要素 Map を構築

    Note over CL: --- フィルター要素の事前処理 ---

    loop 可視レイヤーごと
        CL->>CL: フィルター付き要素を収集・分類
        Note over CL: pre-filter → segments に直接適用
        Note over CL: post-filter → オフスクリーンに描画 → filteredTextures に格納
        Note over CL: backdrop-filter → backdropElements 配列に保存
    end

    CL->>CL: viewport uniform を復元
    Note over CL: フィルター事前処理中に uniform を変更した可能性があるため

    Note over CL: --- メインレンダーパス ---
    Note over CL: 背景色: artboard あり → グレー / なし → 白
    CL->>CL: レンダーパスを開始 (クリア付き)

    opt artboard あり
        CL->>CL: artboard 背景を描画
    end

    loop 可視レイヤーごと
        alt backdrop 要素ありのレイヤー
            loop backdrop 要素を z-order 順に処理
                CL->>CL: backdrop 前の要素を描画 (backdrop 要素自体はスキップ)
                CL->>CL: パスを終了
                CL->>CL: backdrop フィルターを処理
                Note over CL: → backdrop フィルター処理の詳細は後述
                CL->>CL: 新しいパスを開始 (クリアなし)
            end
            CL->>CL: 残りの要素を描画
        else backdrop 要素なしのレイヤー
            CL->>CL: レイヤーの全要素を描画
        end
    end

    CL->>CL: パスを終了
```

---

## 全体フロー (flowchart)

```mermaid
flowchart TD
    Entry[CanvasLayer.render]

    Entry --> CacheCheck{needsDocumentRender?}

    CacheCheck -- Yes --> OversizeSetup[canvasSize をオーバーサイズに差し替え]
    OversizeSetup --> CacheEnc[専用 cacheEncoder 作成]
    CacheEnc --> DocRender[renderDocument]
    DocRender --> Submit[cacheEncoder を即座に submit]
    Submit --> RecordBounds[cachedWorldBounds を記録]
    RecordBounds --> Restore[canvasSize / uniforms / stencil を復元]
    Restore --> Blit

    CacheCheck -- No --> Blit[blitDocumentCacheToCanvas]

    Blit --> Preview{previewPath あり?}
    Preview -- Yes --> PreviewRender[renderPath on main encoder]
    Preview -- No --> End[render 完了]
    PreviewRender --> End
```

### renderDocument 内部フロー (flowchart)

```mermaid
flowchart TD
    Entry[renderDocument]

    Entry --> Collect[collectFilteredElements]

    Collect --> FilterSep{フィルター分類}
    FilterSep -- pre-filter --> PreStore[segments に直接適用]
    FilterSep -- post-filter --> PostRender[renderElementToTexture]
    FilterSep -- backdrop-filter --> BackdropStore[backdropElements に保存]
    PostRender --> FilteredMap[filteredTextures Map に格納]

    FilteredMap --> MainPass
    PreStore --> MainPass
    BackdropStore --> MainPass

    MainPass[メインレンダーパス開始] --> ArtboardBg[renderArtboardBackgrounds]
    ArtboardBg --> LayerLoop[レイヤーごとにループ]

    LayerLoop --> HasBackdrop{backdrop 要素あり?}
    HasBackdrop -- No --> RenderNormal[renderElements]
    HasBackdrop -- Yes --> BackdropFlow

    subgraph BackdropFlow [backdrop 要素の処理]
        direction TB
        RenderBefore[renderElements - backdrop 前] --> EndPass[パス終了]
        EndPass --> ProcessBD[processBackdropElement]
        ProcessBD --> NewPass[新しいパス開始]
        NewPass --> RenderAfter[renderElements - backdrop 後]
    end

    RenderNormal --> Dispatch
    BackdropFlow --> Dispatch

    Dispatch[要素タイプ判定]

    Dispatch -- Path --> PathFlow[renderPath]
    Dispatch -- Text --> TextFlow[renderText]
    Dispatch -- Image --> ImageFlow[renderImage]
    Dispatch -- Group --> GroupFlow[renderElements 再帰]
    Dispatch -- CompoundPath --> CompoundFlow[renderCompoundPath]
    Dispatch -- Filtered --> BlitFlow[blitTextureToCanvas]

    PathFlow --> Done
    TextFlow --> Done
    ImageFlow --> Done
    GroupFlow --> Done
    CompoundFlow --> Done
    BlitFlow --> Done

    Done[renderDocument 完了]
```

---

## パスレンダリング - renderPath

```mermaid
flowchart TD
    RP[renderPath]

    RP --> PreFilter[applyPreFilters - zigzag等]

    PreFilter --> HasFill{path.fillあり?}
    HasFill -- Yes --> FillBranch[renderPathFill]
    HasFill -- No --> StrokeCheck

    FillBranch --> StrokeCheck{path.brushSettingsあり?}
    StrokeCheck -- Yes --> BrushStroke[brushStrokeRenderer.render]
    StrokeCheck -- No --> LegacyCheck{path.colorあり?}
    LegacyCheck -- Yes --> Legacy[renderPathLegacy]
    LegacyCheck -- No --> Skip[スキップ]
```

---

## フィルレンダリング - renderPathFill

CPU 側で earcut による三角形分割を行い、頂点バッファに書き込んでから GPU に描画させる。

```mermaid
flowchart TD
    Fill[renderPathFill]

    Fill --> Offset[ワールドオフセット除去 - earcut FP安定化]
    Offset --> Split[splitIntoSubPaths - isMovedフラグ]
    Split --> Flatten[flattenBezierPath - 10 steps per segment]
    Flatten --> Cleanup[cleanupPolygonPoints]

    Cleanup --> SubCount{サブパス数}
    SubCount -- 1 --> Earcut1[earcut で三角形インデックス生成]
    SubCount -- 2以上 --> Group[groupSubPathsByContainment]
    Group --> WindCheck[巻き方向正規化 outer=CCW holes=CW]
    WindCheck --> Earcut2[earcut with holeIndices]

    Earcut1 --> VtxBuild
    Earcut2 --> VtxBuild

    VtxBuild[CPU: 頂点データ構築]

    VtxBuild --> WriteVtx

    subgraph WriteVtx [WRITE: Vertex Buffer]
        direction LR
        VtxLabel[VERTEX COPY_DST]
        VtxData[Float32Array per vertex x y r g b a 0 0]
    end

    WriteVtx --> PipeSel[パイプライン選択]
    PipeSel -- main --> FP[fillPipeline canvasFormat]
    PipeSel -- offscreen --> FPO[fillPipelineOffscreen rgba8unorm]
    PipeSel -- stencil --> FPS[fillPipelineStencil]

    FP --> ReadUni
    FPO --> ReadUni
    FPS --> ReadUni

    subgraph ReadUni [READ: Viewport Uniform BG0:B0]
        direction LR
        UniLabel[GPU reads viewportX viewportY zoom canvasW canvasH]
    end

    ReadUni --> Draw[draw triangle-list]

    subgraph VS [Vertex Shader]
        direction LR
        VSCalc[worldPos = position + offset]
        VSCalc --> VSNDC[relXY = worldPos - viewport times zoom then NDC]
    end

    subgraph FS [Fragment Shader]
        direction LR
        FSCalc[output = color rgba premultiplied]
    end
```

`offset` は fill の場合 `(0, 0)` なので `position` がそのまま使われる。

---

## レガシーストローク - renderPathLegacy

ベジエ曲線を CPU 側で分割し、法線方向のオフセットで太さを表現する triangle-strip。

```mermaid
flowchart TD
    Legacy[renderPathLegacy]

    Legacy --> Sample[ベジエを20 steps/segmentで分割]
    Sample --> Normal[各点で法線ベクトル算出]
    Normal --> VtxBuild[CPU: 頂点データ構築 - 1点につき2頂点]

    VtxBuild --> WriteVtx

    subgraph WriteVtx [WRITE: Vertex Buffer]
        direction LR
        VtxData[Float32Array per vertex x y r g b a offsetX offsetY]
    end

    WriteVtx --> Draw[draw triangle-strip]

    subgraph VS [Vertex Shader]
        direction LR
        VSCalc[worldPos = position + offset で太さ反映]
        VSCalc --> VSNDC[World to NDC]
    end
```

`offset` に法線方向のベクトルが入り、`position + offset` と `position - offset` の2頂点がストロークの両端を形成する。

---

## ブラシストローク - BrushStrokeRenderer

CPU 側でスタンプ位置を算出し、Storage buffer 経由で GPU にインスタンス描画させる。

バッファプールにより、フレームごとの GPU バッファ再作成を回避する。`beginFrame()` でプールインデックスをリセットし、各 `render()` 呼び出しでプールから取得 or 拡張する。

```mermaid
flowchart TD
    BSR[BrushStrokeRenderer.render]

    BSR --> GenStamps[generateStamps]

    subgraph StampGen [CPU: スタンプ生成]
        direction TB
        ArcLen[セグメント弧長近似]
        ArcLen --> Spacing[minSpacing計算]
        Spacing --> Sample[弧長に沿って等間隔サンプリング]
        Sample --> Pressure[筆圧からsize opacity算出]
        Pressure --> StampInst[StampInstance配列]
    end

    GenStamps --> Cull[cullStampsToViewport]
    Cull --> ToF32[stampsToFloat32Array]

    ToF32 --> WriteStamp

    subgraph WriteStamp [WRITE: Stamp Instance Storage Buffer BG0:B1]
        direction LR
        StampData[Float32Array per stamp posX posY size opacity rotation 0 0 0]
    end

    WriteStamp --> WriteBrushColor

    subgraph WriteBrushColor [WRITE: Brush Color Uniform BG1:B0]
        direction LR
        ColorData[Float32Array r g b a]
    end

    WriteBrushColor --> BindTex[Bind: brushTexture BG0:B2 + sampler BG0:B3]

    BindTex --> PipeSel{pipelineType}
    PipeSel -- main --> MainPipe[pipeline canvasFormat]
    PipeSel -- offscreen --> OffPipe[pipelineOffscreen rgba8unorm]
    PipeSel -- stencil --> StPipe[pipelineStencil]

    MainPipe --> DrawCall[draw 6 vertexCount stampsLength instanceCount]
    OffPipe --> DrawCall
    StPipe --> DrawCall

    subgraph VS [Vertex Shader]
        direction TB
        VSRead[READ: stamps instance_index で StampInstance 取得]
        VSRead --> VSLocal[ローカルクワッド -0.5 to 0.5 の6頂点]
        VSLocal --> VSRot[rotation で回転]
        VSRot --> VSScale[size でスケール + position でオフセット]
        VSScale --> VSNDC[READ: Viewport Uniform BG0:B0 で NDC変換]
        VSNDC --> VSOut[出力: NDC position + UV + opacity]
    end

    subgraph FS [Fragment Shader]
        direction TB
        FSTex[READ: brushTexture BG0:B2 を UV でサンプリング]
        FSTex --> FSLum[luminance = R+G+B / 3]
        FSLum --> FSAlpha[finalAlpha = luminance x opacity x colorA]
        FSAlpha --> FSOut[出力: premultiplied RGBA]
    end
```

---

## テキストレンダリング - renderText

グリフをパスに変換し、renderPath に委譲する。バッファ操作は renderPath 側で行われる。

```mermaid
flowchart TD
    RT[renderText]

    RT --> CacheKey[computeTextCacheKey]
    CacheKey --> CacheCheck{textPathCacheにあり?}

    CacheCheck -- No --> AsyncGen[textElementToPaths 非同期]
    AsyncGen --> CacheStore[パスをキャッシュに格納]
    CacheStore --> Rerender[onRequestRender 再描画要求 次フレームで描画]

    CacheCheck -- Yes --> GetPaths[キャッシュからパス配列取得]

    GetPaths --> ForEach[各グリフパスに対して]

    ForEach --> OffsetApply[segments各点に element.x element.y 加算]

    OffsetApply --> StyleResolve[fill stroke brushSettings 解決]

    StyleResolve --> RenderPath[renderPath - fill/stroke のバッファ操作へ]
```

---

## テクスチャ合成 - blitTextureToCanvas

フィルター済みテクスチャやキャッシュテクスチャをキャンバスの指定領域に描画する。

```mermaid
flowchart TD
    Blit[blitTextureToCanvas]

    Blit --> WriteBounds

    subgraph WriteBounds [WRITE: Blit Uniform Buffer BG1:B0]
        direction LR
        BoundsData[Float32Array minX minY maxX maxY ワールド座標]
    end

    WriteBounds --> BindTex[Bind: sampler BG1:B1 + sourceTexture BG1:B2]

    BindTex --> SetPipe[blitPipeline 設定]

    SetPipe --> Draw[draw 6 頂点]

    subgraph VS [Vertex Shader]
        direction TB
        VSQuad[ハードコード6頂点で矩形生成]
        VSQuad --> VSReadUni[READ: Viewport Uniform BG0:B0]
        VSReadUni --> VSReadBlit[READ: Blit Uniform BG1:B0 で bounds 取得]
        VSReadBlit --> VSNDC[bounds のワールド座標を NDC に変換]
        VSNDC --> VSUV[UV マッピング]
    end

    subgraph FS [Fragment Shader]
        direction TB
        FSTex[READ: sourceTexture BG1:B2 を UV でサンプリング]
        FSTex --> FSOut[出力: テクスチャの色をそのまま出力]
    end
```

---

## Backdrop フィルター - FrostGlass

ステンシルバッファで要素形状をマスクし、キャンバス内容をキャプチャしてブラーをかける。

```mermaid
flowchart TD
    PBD[processBackdropElement]

    PBD --> StPass

    subgraph StPass [Pass 1: ステンシル書き込み]
        direction TB
        StClear[ステンシルバッファクリア value=0]
        StClear --> StPipe[stencilWritePipeline 設定]
        StPipe --> StWriteUni[WRITE: Viewport Uniform に要素 bounds]
        StWriteUni --> StRender[renderElementToStencil]
        StRender --> StResult[ステンシルバッファ: 要素形状の領域が value=1]
    end

    StPass --> Capture

    subgraph Capture [BackdropCaptureManager.captureRegion]
        direction TB
        CapBlit[現在の canvasTexture bgra8unorm の要素領域を]
        CapBlit --> CapTex[captureTexture rgba8unorm にコピー]
    end

    Capture --> FilterApply

    subgraph FilterApply [FrostGlassFilterProcessor 2パス]
        direction TB

        WriteH[WRITE: FrostGlass Uniform BG0:B0 Pass1]
        WriteH --> HData[resolution direction=1,0 radius saturation tint applyEffects=0]
        HData --> BindH[Bind: captureTexture BG0:B1 + maskTexture BG0:B3]
        BindH --> DrawH[水平ブラー描画 READ uniform+texture]
        DrawH --> TempTex[中間テクスチャ]

        TempTex --> WriteV[WRITE: FrostGlass Uniform BG0:B0 Pass2]
        WriteV --> VData[direction=0,1 applyEffects=1]
        VData --> BindV[Bind: 中間テクスチャ BG0:B1]
        BindV --> DrawV[垂直ブラー+彩度+ティント+マスク適用]
        DrawV --> FilteredTex[フィルター済みテクスチャ]
    end

    FilterApply --> BlitPass

    subgraph BlitPass [Pass 2: ステンシル付きブリット]
        direction TB
        WriteBlit[WRITE: Blit Uniform BG1:B0 bounds]
        WriteBlit --> BindBlit[Bind: filteredTexture BG1:B2]
        BindBlit --> DrawBlit[blitWithStencilPipeline で描画]
        DrawBlit --> StTest[ステンシルテスト: value==1 のピクセルのみ出力]
    end

    BlitPass --> NewPass[新しいレンダーパス開始]
```

---

## ポストフィルター - Blur

要素をオフスクリーンテクスチャにレンダリングしてから、2パスの分離ガウシアンブラーを適用する。

```mermaid
flowchart TD
    Blur[BlurFilterProcessor.process]

    Blur --> WriteH

    subgraph WriteH [WRITE: Blur Uniform BG0:B0 Pass1]
        direction LR
        HData[StructuredView resolution direction=1,0 radius]
    end

    WriteH --> BindH[Bind: sourceTexture BG0:B1 + sampler BG0:B2]
    BindH --> DrawH[フルスクリーン描画 Pass1]

    subgraph ShaderH [Fragment Shader Pass1]
        direction TB
        ReadH[READ: Uniform BG0:B0 direction radius]
        ReadH --> SampleH[READ: inputTexture BG0:B1 をカーネル幅でサンプリング]
        SampleH --> GaussH[ガウシアンウェイト合成 premultiplied alpha]
    end

    DrawH --> TempTex[WRITE: 中間テクスチャ rgba8unorm]

    TempTex --> WriteV

    subgraph WriteV [WRITE: Blur Uniform BG0:B0 Pass2]
        direction LR
        VData[StructuredView resolution direction=0,1 radius]
    end

    WriteV --> BindV[Bind: 中間テクスチャ BG0:B1]
    BindV --> DrawV[フルスクリーン描画 Pass2]

    subgraph ShaderV [Fragment Shader Pass2]
        direction TB
        ReadV[READ: Uniform BG0:B0 direction radius]
        ReadV --> SampleV[READ: inputTexture BG0:B1 を垂直にサンプリング]
        SampleV --> GaussV[ガウシアンウェイト合成 un-premultiply]
    end

    DrawV --> Result[WRITE: ブラー済みテクスチャ]
```

---

## エクスポートフロー - renderForExport

```mermaid
flowchart TD
    Export[renderForExport]

    Export --> TexCreate[CREATE: オフスクリーンテクスチャ rgba8unorm COPY_SRC]

    TexCreate --> WriteUni

    subgraph WriteUni [WRITE: Viewport Uniform BG0:B0]
        direction LR
        UniData[Float32Array artboard.x artboard.y scale exportWidth exportHeight]
    end

    WriteUni --> RenderPass[レンダーパス開始 clearValue=backgroundColor]
    RenderPass --> Pipeline[strokePipelineOffscreen 設定]
    Pipeline --> Layers[renderElements pipelineType=offscreen]

    Layers --> RestoreUni

    subgraph RestoreUni [WRITE: Viewport Uniform BG0:B0 復元]
        direction LR
        RestoreData[Float32Array 元の viewport.x y zoom canvasW canvasH]
    end

    RestoreUni --> CopyTex[copyTextureToBuffer]

    subgraph CopyTex [READ: GPU texture to CPU]
        direction TB
        ReadBuf[CREATE: Read Buffer MAP_READ COPY_DST]
        ReadBuf --> CopyCmd[copyTextureToBuffer 256byte row alignment]
        CopyCmd --> MapAsync[mapAsync MAP_READ]
        MapAsync --> GetData[getMappedRange で Uint8ClampedArray 取得]
    end

    CopyTex --> RemovePad[行パディング除去 256byte alignment to width x 4]
    RemovePad --> ToImageData[new ImageData width height]
    ToImageData --> ToPNG[OffscreenCanvas putImageData convertToBlob image/png]
    ToPNG --> Download[Blob URL でダウンロード]
```

---

## パイプライン一覧

| パイプライン | フォーマット | トポロジー | 用途 |
|---|---|---|---|
| `strokePipeline` | canvasFormat (bgra8unorm) | triangle-strip | レガシーストローク・アートボード背景 |
| `strokePipelineOffscreen` | rgba8unorm | triangle-strip | オフスクリーン描画 |
| `fillPipeline` | canvasFormat | triangle-list | earcut フィル |
| `fillPipelineOffscreen` | rgba8unorm | triangle-list | オフスクリーンフィル |
| `fillPipelineStencil` | canvasFormat + depth-stencil | triangle-list | ステンシル書き込み用フィル |
| `blitPipeline` | canvasFormat | triangle-list (6頂点) | テクスチャ合成 |
| `blitWithStencilPipeline` | canvasFormat + depth-stencil | triangle-list (6頂点) | ステンシル付きテクスチャ合成 |
| `stencilWritePipeline` | canvasFormat + depth-stencil | triangle-strip | ステンシルマスク書き込み |
| Brush `pipeline` | canvasFormat | triangle-list | ブラシスタンプ (メイン) |
| Brush `pipelineOffscreen` | rgba8unorm | triangle-list | ブラシスタンプ (オフスクリーン) |
| Brush `pipelineStencil` | canvasFormat + depth-stencil | triangle-list | ブラシスタンプ (ステンシル) |

---

## GPUバッファ一覧

| バッファ | サイズ | Usage | Bind Group | Binding | CPU型 | 書き込みデータ |
|---|---|---|---|---|---|---|
| Viewport Uniform | 20 B | UNIFORM | 0 | 0 | Float32Array x5 | viewportX viewportY zoom canvasW canvasH |
| Path Vertex | 可変 | VERTEX | - | - | Float32Array x8n | x y r g b a offsetX offsetY per vertex |
| Stamp Instance | 可変 | STORAGE | 0 | 1 | Float32Array x8n | posX posY size opacity rotation 0 0 0 per stamp |
| Brush Color | 16 B | UNIFORM | 1 | 0 | Float32Array x4 | r g b a |
| Blit Uniform | 16 B | UNIFORM | 1 | 0 | Float32Array x4 | minX minY maxX maxY world coords |
| Blur Uniform | 32 B | UNIFORM | 0 | 0 | StructuredView | resolution direction radius + padding |
| FrostGlass Uniform | 64 B | UNIFORM | 0 | 0 | StructuredView | resolution direction radius saturation tintRGB tintOpacity applyEffects useMask + padding |
| Export Read | 可変 | MAP_READ COPY_DST | - | - | Uint8ClampedArray | RGBA pixels 256byte row aligned |

---

## GPUテクスチャ一覧

| テクスチャ | サイズ | Format | Usage | 用途 |
|---|---|---|---|---|
| Document Cache | canvasSize × 2.0 | canvasFormat | RENDER_ATTACHMENT + TEXTURE_BINDING + COPY_SRC | オーバーサイズドキュメントキャッシュ |
| Stencil | canvasSize (描画時はキャッシュサイズ) | depth24plus-stencil8 | RENDER_ATTACHMENT | backdrop フィルターのステンシルマスク |
| Filtered Element | 要素 bounds | rgba8unorm | RENDER_ATTACHMENT + TEXTURE_BINDING | post-filter 済み要素 |
| Backdrop Capture | 要素 bounds | rgba8unorm | COPY_DST + TEXTURE_BINDING | backdrop キャプチャ領域 |
| Brush Texture | ブラシごと | rgba8unorm | TEXTURE_BINDING + COPY_DST | ブラシスタンプテクスチャ |
| Image Texture | 画像ごと | rgba8unorm | TEXTURE_BINDING + COPY_DST | 画像オブジェクト |

---

## GPU Struct 定義

```
stroke.wgsl - Viewport Uniform (BG0:B0):
  struct Uniforms { viewportX: f32, viewportY: f32, zoom: f32, canvasWidth: f32, canvasHeight: f32 }

stroke.wgsl - Vertex Input:
  struct VertexInput { position: vec2f, color: vec4f, offset: vec2f }
  position + offset = world座標  ->  Uniforms で NDC 変換

brushStamp.wgsl - Stamp Instance (BG0:B1 storage read):
  struct StampInstance { positionX: f32, positionY: f32, size: f32, opacity: f32, rotation: f32, pad x3 }
  instance_index で配列アクセス  ->  ローカルクワッド回転スケール  ->  Uniforms で NDC 変換

brushStamp.wgsl - Brush Color (BG1:B0):
  struct BrushUniforms { colorR: f32, colorG: f32, colorB: f32, colorA: f32 }
  FS: finalAlpha = texLuminance * stampOpacity * colorA  ->  premultiplied RGBA 出力

blit.wgsl - Blit Bounds (BG1:B0):
  struct BlitUniforms { boundsMinX: f32, boundsMinY: f32, boundsMaxX: f32, boundsMaxY: f32 }
  VS: bounds world coords  ->  Viewport Uniform で NDC 変換  ->  UV マッピング

blur.wgsl - Blur Uniform (BG0:B0):
  struct Uniforms { resolution: vec2f, direction: vec2f, radius: f32 }
  FS: direction方向にカーネル幅サンプリング  ->  ガウシアンウェイト合成

frostGlass.wgsl - FrostGlass Uniform (BG0:B0):
  struct Uniforms { resolution: vec2f, direction: vec2f, radius: f32, saturation: f32,
                    tintR: f32, tintG: f32, tintB: f32, tintOpacity: f32, applyEffects: f32, useMask: f32 }
  FS Pass1: ブラーのみ (applyEffects=0)
  FS Pass2: ブラー + 彩度 + ティント + マスク (applyEffects=1)
```
