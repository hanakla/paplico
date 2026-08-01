# Paplico

WebGPU-powered infinite canvas drawing application with real-time collaboration.

## Features

- **Infinite Canvas** - Pan, zoom, and draw without boundaries
- **WebGPU Rendering** - Hardware-accelerated rendering pipeline
- **Pressure-Sensitive Drawing** - Pen and brush tools with full stylus support
- **Real-time Collaboration** - Multi-user editing via Yjs CRDT
- **Layer System** - Layer management with blend modes and opacity
- **Vector Path Editing** - Cubic bezier path creation and editing
- **Shape Tools** - Rectangle, ellipse, and line primitives
- **Text Tool** - Text elements with Google Fonts integration
- **Mesh Deformation** - Mesh-based element deformation
- **Gradient Editor** - Linear and radial gradient fills
- **Post-processing Filters** - Blur, frost glass, drop shadow, zigzag
- **Undo/Redo** - Full history via Yjs UndoManager
- **Export** - PNG export and CBOR document serialization

## Tech Stack

| Category         | Technology                 |
| ---------------- | -------------------------- |
| Framework        | Next.js 16, React 19       |
| Rendering        | WebGPU (WGSL shaders)      |
| Styling          | Tailwind CSS 4             |
| State (App)      | Zustand                    |
| State (Document) | Valtio                     |
| Collaboration    | Yjs, y-websocket, PartyKit |
| Auth             | Supabase Auth              |
| Serialization    | CBOR                       |
| Testing          | Vitest                     |
| Linting          | Biome                      |

## Getting Started

### Prerequisites

- Node.js 24+
- Yarn 4 (Corepack)
- A browser with WebGPU support (Chrome 113+, Edge 113+, Firefox Nightly)

### Environment Variables

Copy `pkgs/web/.env.example` to `pkgs/web/.env` and fill in the values:

| Variable                                   | Required   | Description                                         |
| ------------------------------------------ | ---------- | --------------------------------------------------- |
| `SUPABASE_URL`                             | Yes        | Supabase API URL                                    |
| `SUPABASE_PUBLISHABLE_KEY`                 | Yes        | Supabase publishable key (`sb_publishable_...`)     |
| `SUPABASE_SECRET_KEY`                      | Yes        | Supabase secret key (`sb_secret_...`, server only)  |
| `SUPABASE_JWT_SECRET`                      | Cloud      | HS256 symmetric key for JWT verification (PartyKit) |
| `NEXT_PUBLIC_COLLAB_MODE`                  | No         | `local` (default) or `cloud`                        |
| `NEXT_PUBLIC_PARTYKIT_HOST`                | Cloud      | PartyKit WebSocket host                             |
| `NEXT_PUBLIC_API_BASE_URL`                 | Tauri prod | API server URL (e.g. `https://paplico.hanak.la`)    |
| `NEXT_PUBLIC_GOOGLE_FONTS_API_KEY`         | No         | Google Fonts API key                                |
| `ROOM_SIGNING_SECRET`                      | No         | HMAC secret for room tokens                         |
| `SUPABASE_AUTH_EXTERNAL_DISCORD_CLIENT_ID` | Cloud      | Discord OAuth Client ID                             |
| `SUPABASE_AUTH_EXTERNAL_DISCORD_SECRET`    | Cloud      | Discord OAuth Secret                                |
| `SUPABASE_AUTH_EXTERNAL_X_CLIENT_ID`       | Cloud      | X OAuth Client ID                                   |
| `SUPABASE_AUTH_EXTERNAL_X_SECRET`          | Cloud      | X OAuth Secret                                      |

#### GitHub Actions Secrets

| Secret                                     | Description                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                    | Supabase Personal Access Token ([generate here](https://supabase.com/dashboard/account/tokens)) |
| `SUPABASE_DEV_PROJECT_REF`                 | Dev project Reference ID                                                                        |
| `SUPABASE_PROD_PROJECT_REF`                | Prod project Reference ID                                                                       |
| `SUPABASE_AUTH_EXTERNAL_DISCORD_CLIENT_ID` | Discord OAuth Client ID                                                                         |
| `SUPABASE_AUTH_EXTERNAL_DISCORD_SECRET`    | Discord OAuth Secret                                                                            |
| `SUPABASE_AUTH_EXTERNAL_X_CLIENT_ID`       | X OAuth Client ID                                                                               |
| `SUPABASE_AUTH_EXTERNAL_X_SECRET`          | X OAuth Secret                                                                                  |
| `SUPABASE_JWT_SECRET`                      | HS256 symmetric key for JWT verification                                                        |
| `ROOM_SIGNING_SECRET`                      | HMAC secret for room token verification                                                         |

### Install

```bash
# From repository root
yarn install
```

### Supabase (Local)

Supabase is managed locally via the [Supabase CLI](https://supabase.com/docs/guides/local-development), which orchestrates Docker containers internally.

```bash
# Start Supabase (DB, Auth, API gateway) — run from pkgs/web
cd pkgs/web && yarn db:dev:start

# Check status and connection info
yarn db:dev:status

# Reset DB (re-apply all migrations)
yarn db:dev:reset

# Stop Supabase
yarn db:dev:stop
```

After `yarn db:dev:start`, copy the displayed `Publishable` and `Secret` keys into `pkgs/web/.env`.

### Development

```bash
# Start dev server (from repository root)
yarn dev

# Or from pkgs/web directly
cd pkgs/web && yarn dev
```

### Build

```bash
yarn build
```

### Test

```bash
cd pkgs/web && yarn test
```

### Lint

```bash
# From repository root
yarn lint:fix
```

## Project Structure

```
pkgs/web/
├── server.js                 # WebSocket server for Yjs collaboration
└── src/
    ├── core/                 # Drawing engine
    │   ├── Paplico.ts            # Main engine orchestrator
    │   ├── PaplicoCommands.ts    # Command pattern for document ops
    │   ├── PaplicoSelection.ts   # Selection state management
    │   ├── SpatialIndex.ts       # Spatial indexing for hit testing
    │   ├── renderer/             # WebGPU rendering pipeline
    │   │   ├── filters/          # Post-processing filters
    │   │   └── shaders/          # WGSL shader sources
    │   ├── tools/                # Drawing tools
    │   ├── collaboration/        # Yjs provider & real-time sync
    │   ├── typography/           # Text layout & font management
    │   ├── ui/                   # UI overlay (cursors, selection)
    │   ├── export/               # PNG export
    │   ├── io/                   # CBOR serialization
    │   └── utils/                # Coordinates, bounds, path ops
    ├── app/                  # Next.js app directory
    ├── components/           # Reusable UI components
    ├── organisms/            # Page-level compositions
    ├── contexts/             # React contexts
    ├── stores/               # Zustand / Valtio stores
    └── utils/                # App-level utilities
```

## Monorepo

This is part of a Yarn 4 monorepo:

| Package                       | Description                                  |
| ----------------------------- | -------------------------------------------- |
| `pkgs/web`                    | Main application (this package)              |
| `pkgs/core`                   | Shared utilities and types (`@paplico/core`) |
| `pkgs/partykit-collab-server` | PartyKit collaboration server                |

## Architecture

### Coordinate Systems

Paplico uses three coordinate systems:

1. **Screen Space** - Browser viewport pixels (origin: top-left, Y-down)
2. **World Space** - Logical drawing coordinates (origin: center, Y-up, zoom-independent)
3. **NDC** - Normalized device coordinates for WebGPU shaders

All element data is stored in world coordinates. Screen coordinates are ephemeral.

### Data Flow

```
User Input → Tool → PaplicoCommands → YjsProvider → Yjs Doc
                                                       ↓
                              React ← Valtio ← syncYjsToValtio
                                                       ↓
                                              WebSocket → Remote peers
```

### Rendering Pipeline

WebGPU viewport-based rendering with:

- Viewport culling (only visible elements rendered)
- Layer texture caching
- Dirty flag incremental updates
- LOD based on zoom level
