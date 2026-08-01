# PAPF (Paplico Packed Format) v1

Paplico プロジェクトファイルのバイナリフォーマット仕様。

## 設計目標

- **遅延読み込み**: メタデータだけ先に読み、埋め込みファイル（画像・フォント・ブラシテクスチャ）のバイナリは必要時にオンデマンドで読む
- **ストリーム書き出し**: セクションを順次書き出し、ファイル全体を一括バッファしない
- **圧縮**: セクション単位で圧縮/非圧縮を選択可能
- **前方互換性**: セクションタイプの追加で拡張可能
- **ブラウザ互換**: File System Access API に依存しない。`File.slice()` によるランダムアクセスと `Blob` 経由のダウンロードで動作する

## ファイル構造

```
┌──────────────────────┐
│ FileHeader    (32 B) │
├──────────────────────┤
│ META Section         │  ドキュメント構造 (CBOR)
├──────────────────────┤
│ FILE Section  #1     │  埋め込みファイル (純バイナリ)
│ FILE Section  #2     │
│ ...                  │
├──────────────────────┤
│ TMLH Section         │  タイムラプスマニフェスト
│ TMLB Section  #1     │  タイムラプスブロック
│ TMLB Section  #2     │
│ ...                  │
├──────────────────────┤
│ TOC Section          │  目次 (全セクションの位置情報)
├──────────────────────┤
│ Footer        (40 B) │  TOC の位置を指す
└──────────────────────┘
```

セクション間にアライメントパディングは入らない。全数値はリトルエンディアン。

---

## バイナリ構造

### FileHeader (32 bytes)

| Offset | Size | Type  | Field           | Description              |
|--------|-----:|-------|-----------------|--------------------------|
| 0      | 4    | bytes | magic           | `PAPF` (0x50 41 50 46)  |
| 4      | 2    | u16   | formatMajor     | フォーマットメジャーバージョン |
| 6      | 2    | u16   | formatMinor     | フォーマットマイナーバージョン |
| 8      | 4    | u32   | headerBytes     | 常に 32                  |
| 12     | 4    | u32   | flags           | 予約 (0)                 |
| 16     | 8    | u64   | createdAtUnixMs | 作成時刻 (Unix ms)       |
| 24     | 8    | u64   | reserved        | 予約 (0)                 |

### SectionHeader (16 bytes)

全セクション共通。セクションの直前に置かれる。

| Offset | Size | Type  | Field              | Description                   |
|--------|-----:|-------|--------------------|-------------------------------|
| 0      | 4    | bytes | magic              | `PSEC` (0x50 53 45 43)       |
| 4      | 2    | u16   | sectionType        | セクション種別                 |
| 6      | 2    | u16   | codec              | 圧縮コーデック                 |
| 8      | 8    | u64   | payloadStoredBytes | ペイロードの格納バイト数 (圧縮後) |

### Footer (40 bytes)

ファイル末尾に配置される。TOC の位置を記録する。

| Offset | Size | Type  | Field            | Description                     |
|--------|-----:|-------|------------------|---------------------------------|
| 0      | 4    | bytes | magic            | `PEND` (0x50 45 4E 44)         |
| 4      | 2    | u16   | formatMajor      | FileHeader と同じ値              |
| 6      | 2    | u16   | formatMinor      | FileHeader と同じ値              |
| 8      | 2    | u16   | footerBytes      | 常に 40                         |
| 10     | 2    | u16   | flags            | 予約 (0)                        |
| 12     | 8    | u64   | tocSectionOffset | TOC セクションの先頭オフセット    |
| 20     | 8    | u64   | tocSectionBytes  | TOC セクション全体のバイト数 (ヘッダ含む) |
| 28     | 8    | u64   | fileBytes        | ファイル全体のバイト数            |
| 36     | 4    | u32   | tocPayloadCrc32  | TOC ペイロードの CRC-32          |

---

## セクション種別

| 値       | 名前 | Description                                                                 |
|----------|------|-----------------------------------------------------------------------------|
| `0x0001` | META | ドキュメントメタデータ。CBOR エンコード。バイナリデータ (`EmbeddedFile.bin`, タイムラプス更新データ) を含まない |
| `0x0002` | FILE | 埋め込みファイル 1 件分の純バイナリ。TOC の key でファイル UID と紐づく       |
| `0x0003` | TMLH | タイムラプスマニフェスト。CBOR エンコード                                     |
| `0x0004` | TMLB | タイムラプスブロック。複数の Yjs 更新をまとめたバイナリ                       |
| `0x00FF` | TOC  | 目次。全セクションの位置・サイズ・コーデック情報を格納                        |

`0x8000`〜`0xFFFF` はベンダー/カスタム用に予約。

## コーデック

| 値 | 名前    | Description                                              |
|----|---------|----------------------------------------------------------|
| 0  | none    | 無圧縮                                                   |
| 1  | deflate | ブラウザネイティブ (`CompressionStream` / `DecompressionStream`) |

### 圧縮ポリシー

| セクション | デフォルトコーデック | 理由                                          |
|------------|---------------------|-----------------------------------------------|
| META       | deflate             | テキスト/JSON 的データ、圧縮効果が高い         |
| FILE       | MIME 依存           | 下表参照                                       |
| TMLH       | deflate             | 小さいマニフェスト                              |
| TMLB       | deflate             | Yjs 更新データ、圧縮効果が高い                  |
| TOC        | none                | 読み込み時にまず TOC をパースするため無圧縮が効率的 |

FILE セクションの MIME ベースヒューリスティック:

| MIME type                               | コーデック | 理由                |
|-----------------------------------------|-----------|---------------------|
| `image/png`, `image/jpeg`, `image/webp` | none      | 既に圧縮済み         |
| `font/woff2`                            | none      | 既に圧縮済み         |
| その他                                   | deflate   | 圧縮で削減が見込める |

---

## TOC (Table of Contents)

### TocHeader (16 bytes)

| Offset | Size | Type | Field            |
|--------|-----:|------|------------------|
| 0      | 2    | u16  | tocMajor         |
| 2      | 2    | u16  | tocMinor         |
| 4      | 4    | u32  | entryCount       |
| 8      | 4    | u32  | stringTableBytes |
| 12     | 4    | u32  | flags            |

### TocEntry (32 bytes)

| Offset | Size | Type | Field         | Description                                 |
|--------|-----:|------|---------------|---------------------------------------------|
| 0      | 8    | u64  | sectionOffset | セクションヘッダの先頭オフセット              |
| 8      | 4    | u32  | storedBytes   | 格納バイト数 (圧縮後)                         |
| 12     | 4    | u32  | rawBytes      | 非圧縮バイト数 (不明時 0)                     |
| 16     | 4    | u32  | keyOffset     | StringTable 内のオフセット (`0xFFFFFFFF` = なし) |
| 20     | 4    | u32  | aux0          | セクション種別固有の補助値                     |
| 24     | 4    | u32  | aux1          | セクション種別固有の補助値                     |
| 28     | 2    | u16  | sectionType   | セクション種別 (SectionHeader と同値)          |
| 30     | 1    | u8   | codec         | コーデック (SectionHeader と同値)              |
| 31     | 1    | u8   | entryFlags    | 予約 (0)                                     |

### StringTable

TocEntry 配列の直後に配置。UTF-8 NUL 終端文字列の連結。

- FILE エントリの key: 埋め込みファイルの UID
- META エントリの key: `meta/main`
- TMLH エントリの key: `timelapse/main`
- TMLB エントリの key: 省略可 (`keyOffset = 0xFFFFFFFF`)

### aux フィールドの用途

| セクション種別 | aux0              | aux1        |
|---------------|-------------------|-------------|
| TMLB          | startUpdateIndex  | updateCount |
| その他         | 0 (未使用)         | 0 (未使用)   |

### TOC ペイロードのバイナリレイアウト

```
[TocHeader 16B]
[TocEntry × entryCount]
[StringTable]
```

---

## META ペイロード

CBOR エンコードされた以下の構造:

```typescript
type MetaPayload = {
  // META スキーマバージョン (ファイルフォーマットバージョンとは独立)
  metaSchemaMajor: number;
  metaSchemaMinor: number;

  // ドキュメント構造 (バイナリデータを除く)
  document: {
    id: string;
    objects: Record<string, AnyArtObject>;
    layers: Layer[];
    viewport: Viewport;
    artboards: Artboard[];
    brushPresets: BrushPreset[];
    hdr?: HdrSettings;
    colorProfile?: ColorProfileSettings;
    rasterizationDpi?: number;
    defs?: Record<string, DefEntry>;
    references3d?: Record<string, Reference3DDef>;
  };

  // 埋め込みファイルのメタ情報 (バイナリは FILE セクションに分離)
  fileManifest: Array<{
    uid: string;        // FILE セクションの TOC key と一致
    name: string;       // 元ファイル名
    type: string;       // MIME type
    hash: string;       // SHA-256 hex
    byteLength: number; // 非圧縮バイト数
  }>;

  // タイムラプスメタ情報
  timelapse?: {
    schemaVersion: number;
    totalUpdates: number;
    blockCount: number;
  };
};
```

`document.files` のバイナリは FILE セクションへ、`document.timelapse` は TMLH/TMLB セクションへ分離されるため、META には含まれない。

`hdr`、`colorProfile`、`rasterizationDpi`、`defs`、`references3d` は後方互換性のため任意フィールドである。`toDocument()` は `defs` と `references3d` が存在しない場合に空オブジェクトを補う。

### バージョニング

- ファイルフォーマットバージョン (`PAPF` の `formatMajor/Minor`) と META スキーマバージョンは独立した値である
- 現行 reader は FileHeader と Footer の `formatMajor/Minor` が一致することを検証するが、対応バージョンとの比較は行わない
- 現行 reader は `metaSchemaMajor/Minor` を読み取るが、この値による拒否や分岐は行わない
- `toDocument()` はドキュメントを組み立てた後に `applyMigrations()` を実行する
- TOC の `tocMajor` は 1 のみ受理する

---

## 整合性検証

`openPapf()` は以下を検証する:

1. ファイルサイズが FileHeader と Footer の合計以上である
2. FileHeader の magic が `PAPF`、`headerBytes` が 32 である
3. Footer の magic が `PEND`、`footerBytes` が 40 である
4. Footer の `formatMajor/Minor` が FileHeader と一致する
5. Footer の `fileBytes` がファイルの実際のサイズと一致する
6. TOC セクションの読み取り範囲がファイル内に収まる
7. TOC セクションの magic が `PSEC`、`sectionType` が `0x00FF` である
8. `tocMajor` が 1、`entryCount` が 100,000 以下、`stringTableBytes` が 10 MiB 以下である
9. TOC ペイロードが宣言されたエントリ配列と StringTable を格納できるサイズである
10. TOC に META エントリがちょうど1件ある
11. TOC ペイロードの CRC-32 が Footer の `tocPayloadCrc32` と一致する
12. META ペイロードの読み取り範囲がファイル内に収まる

FILE とタイムラプスの各ペイロードは遅延読み込み時に範囲検証される。FILE の読み込みでは、TOC と `fileManifest` の両方に UID が存在すること、格納サイズが 1 GiB 以下であること、`rawBytes` が指定されている場合は解凍後のサイズが一致することも検証される。codec は `none` と `deflate` のみ受理され、それ以外は該当ペイロードの読み込み時に拒否される。

書き込みが中断された場合、Footer が存在しないためファイルは無効と判定される。

---

## 読み込みフロー

```
1. file.slice(0, 32)               → FileHeader を読みバリデーション
2. file.slice(file.size - 40, end) → Footer を読みバリデーション
3. FileHeader と Footer のバージョン、および実ファイルサイズを検証
4. file.slice(tocOffset, tocEnd)   → TOC セクションを読みパース
5. TOC ペイロードの CRC-32 を検証
6. TOC から単一の META エントリを特定し、codec に従って読み込み・解凍・CBOR デコード
7. PapfFile を返す (この時点で全ファイルのメタ情報は取得済み、FILE/TMLH/TMLB のペイロードは未読み込み)
8. getEmbeddedFile(uid) 呼び出し時に対象の FILE ペイロードだけを読み込み・解凍
9. getTimelapseData() 呼び出し時に TMLH と、aux0 の昇順に並べた全 TMLB ペイロードを読み込み・解凍・CBOR デコード
10. toDocument() 呼び出し時は全 FILE とタイムラプスを読み込み、マイグレーションと正規化を適用して Document を返す
```

`getTimelapseData()` は TMLH エントリが存在しない場合に `null` を返す。`toDocument()` は全 FILE を `Promise.all()` で読み込むため、多数または大容量の埋め込みファイルを扱う場合は `getEmbeddedFile()` による個別読み込みを使用する。

## 書き込みフロー

```
1. チャンクコレクターを作成 (Uint8Array[] + バイトカウンター)
2. FileHeader を書き出し
3. META セクションを書き出し (CBOR エンコード → deflate)
4. 各 EmbeddedFile の FILE セクションを書き出し (codec 選択 → 書き出し)
   → TOC エントリに位置・サイズ・codec を記録
5. TMLH, TMLB セクションを書き出し
   → TOC エントリに記録
6. TOC ペイロードを構築 → TOC セクションを書き出し
7. Footer を書き出し (TOC オフセット・サイズ・CRC)
8. 全チャンクから Blob を構築しダウンロード
```
