[English](./README.md) | **日本語**

# Paplico

**どこまでも描ける。いつまでも磨ける。— ベジェの精密さと、イマドキの使い心地で。**

WebGPUで動く、リアルタイム共同編集対応の無限キャンバスお絵かきアプリケーション。

## 特徴

- **無限キャンバス** — 境界のないキャンバスを自由にパン・ズームして描画
- **高速レンダリング** — 大きなキャンバスでもなめらかに描ける
  - WebGPU (WGSLシェーダ) で動いています
- **筆圧対応** — スタイラスの筆圧を活かしたペン・ブラシツール
- **リアルタイム共同編集** — みんなで描くのはもちろん、ひとりで同じキャンバスを複数の端末から開いて描くのにも使える
  - Yjs CRDTで動いています
- **コンパニオンモード** — スマホやタブレットをつないで、ブラシ・色・ツール・レイヤーを操作するリモートパネルにできる
- **レイヤーシステム** — ブレンドモード・不透明度・クリッピングを備えたレイヤー管理
- **ベクターパス編集** — 描いた線を、あとから好きなだけ描き直せる
  - 3次ベジェパスで動いています
- **シェイプ・テキストツール** — 図形プリミティブ、パス沿いテキスト、Google Fonts連携
- **メッシュ変形とグラデーション** — メッシュベースの変形、線形・放射・メッシュグラデーション
- **ポストプロセスフィルタ** — ブラー、すりガラス、ドロップシャドウなど
- **自動化スクリプト** — Syrupで書いたスクリプトで操作を自動化できる
  - 静的型付きのスクリプト言語を、サンドボックス化されたワーカーで実行しています
- **Undo/Redo** — どこまでも戻れる完全な履歴
  - Yjs UndoManagerで動いています
- **インポート/エクスポート** — PNG / AVIF (HDR) / PSD 書き出しと `.papf` ドキュメント形式
  - CBORシリアライズで動いています
- **デスクトップアプリ** — ネイティブのデスクトップアプリとして使える
  - Tauri v2で動いています

## 技術スタック

| カテゴリ       | 技術                       |
| -------------- | -------------------------- |
| フレームワーク | Next.js, React             |
| レンダリング   | WebGPU (WGSLシェーダ)      |
| スタイリング   | Tailwind CSS               |
| 状態管理       | Valtio                     |
| 共同編集       | Yjs, y-websocket, PartyKit |
| 認証           | Supabase Auth              |
| シリアライズ   | CBOR                       |
| デスクトップ   | Tauri v2                   |
| テスト         | Vitest                     |
| Lint           | Biome                      |

## パッケージ構成

Yarn 4のmonorepoです。

| パッケージ                    | 説明                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- | -------- |
| `pkgs/web`                    | メインアプリケーション。描画エンジンは `src/core/` にあります             | でえｒｄ |
| `pkgs/core`                   | 共有ユーティリティと型定義 (`@paplico/core`)                              |
| `pkgs/desktop`                | Tauri v2 デスクトップアプリラッパー                                       |
| `pkgs/syrup`                  | Syrupスクリプト言語: パーサ・型検査器・JSエミッタ・ワーカーサンドボックス |
| `pkgs/avif-hdr`               | AVIF HDRのエンコード/デコード                                             |
| `pkgs/partykit-collab-server` | クラウド共同編集モード用のPartyKitサーバ                                  |
| `pkgs/webgpu-devtools`        | WebGPUパイプラインを調査するブラウザ拡張                                  |

## はじめかた

### 必要なもの

- Node.js 24+
- Yarn 4 (Corepack経由)
- WebGPU対応ブラウザ (Chrome / Edge 113+)

### SSL証明書

開発サーバはHTTPSで動きます。Next.js + WebSocketサーバとPartyKit devの両方が、リポジトリルートの `.certs/` ディレクトリから証明書を読み込みます。

```
.certs/
├── localhost-key.pem   # 秘密鍵
└── localhost-cert.pem  # 証明書
```

[mkcert](https://github.com/FiloSottile/mkcert) で生成できます。

```bash
mkcert -install
mkdir -p .certs
mkcert -key-file .certs/localhost-key.pem -cert-file .certs/localhost-cert.pem localhost
```

### インストールと起動

```bash
yarn install

# 開発環境を起動 (Supabase + Next.js dev server + Storybook + PartyKit dev)
yarn dev
```

開発サーバは `https://localhost:5005` で動きます。

### テストとLint

```bash
# テスト実行
yarn workspace pap test

# ビジュアルリグレッションテスト
yarn workspace pap test:visual

# 型チェック
yarn workspace pap typecheck

# Lintと自動修正
yarn lint:fix
```

## アーキテクチャ概要

### 座標系

1. **Screen Space** — ブラウザビューポートのピクセル座標 (原点: 左上、Y軸下向き)
2. **World Space** — 論理描画座標 (原点: 中央、Y軸上向き、ズーム非依存)
3. **NDC** — WebGPUシェーダ用の正規化デバイス座標

全ての要素データはWorld座標で保存されます。

### データフロー

```
User Input → Tool → PaplicoCommands → YjsProvider → Yjs Doc
                                                       ↓
                              React ← Valtio ← syncYjsToValtio
                                                       ↓
                                              WebSocket → Remote peers
```

### レンダリング

ビューポートベースのWebGPUレンダリングで、ビューポートカリング・レイヤーテクスチャキャッシュ・ダーティフラグによる差分更新を行います。詳細な技術仕様は `specification.md` を参照してください。

## ライセンス

Paplicoは [GNU Affero General Public License v3.0 or later](./LICENSE) (AGPL-3.0-or-later) でライセンスされています。
