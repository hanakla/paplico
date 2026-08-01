**English** | [日本語](./README_ja.md)

# Paplico

**Draw infinite. Refine forever — with Bézier precision and a modern experience.**

WebGPU-powered infinite canvas drawing application with real-time collaboration.

## Features

- **Infinite Canvas** — Pan, zoom, and draw without boundaries
- **Fast Rendering** — Hardware-accelerated drawing that stays smooth on large canvases
  - Backed by WebGPU with WGSL shaders
- **Pressure-Sensitive Drawing** — Pen and brush tools with full stylus support
- **Real-time Collaboration** — Draw together, or open the same canvas from multiple devices on your own
  - Backed by Yjs CRDT
- **Companion Mode** — Pair a phone or tablet and use it as a remote panel for brushes, colors, tools, and layers
- **Layer System** — Layer management with blend modes, opacity, and clipping
- **Vector Path Editing** — Draw curves, then reshape them as much as you like
  - Backed by cubic Bézier paths
- **Shape & Text Tools** — Primitives, text on path, and Google Fonts integration
- **Mesh Deformation & Gradients** — Mesh-based deformation, linear/radial/mesh gradients
- **Post-processing Filters** — Blur, frost glass, drop shadow, and more
- **Automation Scripting** — Automate your work with scripts written in Syrup
  - Backed by a statically typed scripting language running in a sandboxed worker
- **Undo/Redo** — Full history, take back anything
  - Backed by Yjs UndoManager
- **Import/Export** — PNG / AVIF (HDR) / PSD export and portable `.papf` documents
  - Backed by CBOR serialization
- **Desktop App** — Runs as a native desktop app
  - Backed by Tauri v2

## Tech Stack

| Category      | Technology                 |
| ------------- | -------------------------- |
| Framework     | Next.js, React             |
| Rendering     | WebGPU (WGSL shaders)      |
| Styling       | Tailwind CSS               |
| State         | Valtio                     |
| Collaboration | Yjs, y-websocket, PartyKit |
| Auth          | Supabase Auth              |
| Serialization | CBOR                       |
| Desktop       | Tauri v2                   |
| Testing       | Vitest                     |
| Linting       | Biome                      |

## Packages

This is a Yarn 4 monorepo:

| Package                       | Description                                                                |
| ----------------------------- | -------------------------------------------------------------------------- |
| `pkgs/web`                    | Main application. The drawing engine lives in `src/core/`                  |
| `pkgs/core`                   | Shared utilities and types (`@paplico/core`)                               |
| `pkgs/desktop`                | Tauri v2 desktop app wrapper                                               |
| `pkgs/syrup`                  | Syrup scripting language: parser, type checker, JS emitter, worker sandbox |
| `pkgs/avif-hdr`               | AVIF HDR encode/decode                                                     |
| `pkgs/partykit-collab-server` | PartyKit server for cloud collaboration mode                               |
| `pkgs/webgpu-devtools`        | Browser extension for inspecting the WebGPU pipeline                       |

## Getting Started

### Prerequisites

- Node.js 24+
- Yarn 4 (via Corepack)
- A browser with WebGPU support (Chrome / Edge 113+)

### SSL Certificates

The dev server (Next.js + WebSocket, and PartyKit dev) runs over HTTPS and reads a certificate from the `.certs/` directory at the repository root:

```
.certs/
├── localhost-key.pem   # Private key
└── localhost-cert.pem  # Certificate
```

Generate them with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkdir -p .certs
mkcert -key-file .certs/localhost-key.pem -cert-file .certs/localhost-cert.pem localhost
```

### Install & Run

```bash
yarn install

# Start development (Supabase + Next.js dev server + Storybook + PartyKit dev)
yarn dev
```

The dev server runs at `https://localhost:5005`.

### Test & Lint

```bash
# Run tests
yarn workspace pap test

# Visual regression tests
yarn workspace pap test:visual

# Type check
yarn workspace pap typecheck

# Lint and auto-fix
yarn lint:fix
```

## Architecture Overview

### Coordinate Systems

1. **Screen Space** — Browser viewport pixels (origin: top-left, Y-down)
2. **World Space** — Logical drawing coordinates (origin: center, Y-up, zoom-independent)
3. **NDC** — Normalized device coordinates for WebGPU shaders

All element data is stored in world coordinates.

### Data Flow

```
User Input → Tool → PaplicoCommands → YjsProvider → Yjs Doc
                                                       ↓
                              React ← Valtio ← syncYjsToValtio
                                                       ↓
                                              WebSocket → Remote peers
```

### Rendering

Viewport-based WebGPU rendering with viewport culling, layer texture caching, and dirty-flag incremental updates. See `specification.md` for the full technical specification.

## License

Paplico is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE) (AGPL-3.0-or-later).
