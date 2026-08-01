# WebGPU DevTools Inspector

A Chrome/Firefox DevTools extension for inspecting and debugging WebGPU applications. Adds a **WebGPU** panel to DevTools that intercepts the WebGPU API and displays real-time information about GPU resources, commands, shaders, and performance.

## Features

- **Device Inspector** — Adapter info, features, and limits of every `GPUDevice`
- **Resource Tracker** — Live list of all GPU resources (buffers, textures, pipelines, samplers, bind groups) with type filtering
- **Texture Viewer** — Visual preview of texture contents with metadata (format, dimensions, usage, mip levels)
- **Buffer Inspector** — Hex / Float32 / Uint32 / Int16 views of buffer data with virtual scrolling
- **Shader Viewer** — WGSL source with syntax highlighting
- **Command Timeline** — Recorded GPU commands (draw, dispatch, copy, passes) with arguments
- **Frame Statistics** — Draw calls, dispatches, and total commands per frame with bar charts
- **Memory Monitor** — Real-time memory usage timeline with per-type breakdown (buffer vs texture)
- **Resource Capture** — Configurable rules to automatically capture textures/buffers exceeding a size threshold
- **Resource Relations** — Dependency graph between resources (pipeline → shader, bind group → buffer, etc.)
- **Error Tracking** — Validation errors, OOM, and device lost events

## Architecture

```
┌─────────────┐     postMessage      ┌──────────────────┐     port      ┌───────────────┐
│  injected.ts │ ──────────────────> │ bridge.content.ts │ ──────────> │  background.ts │
│  (MAIN world)│ <────────────────── │  (content script) │ <────────── │  (service wkr) │
└─────────────┘                      └──────────────────┘              └───────┬───────┘
  Intercepts GPU API                   Relays messages                         │ port
  in page context                      between worlds                          │
                                                                       ┌───────▼───────┐
                                                                       │  devtools-panel │
                                                                       │  (React UI)     │
                                                                       └─────────────────┘
```

- **`injected.ts`** — Runs in the page's MAIN world. Monkey-patches `GPUDevice`, `GPUCommandEncoder`, `GPURenderPassEncoder`, etc. to intercept all resource creation, command recording, and frame boundaries.
- **`bridge.content.ts`** — Content script that relays `postMessage` from the page to the background service worker via `runtime.Port`.
- **`background.ts`** — Service worker that routes messages between content scripts and the DevTools panel.
- **`devtools-panel/`** — React UI with per-feature panels. State managed by Valtio (`store.ts`). Connection logic in `useDevToolsConnection` hook.

## Tech Stack

- [WXT](https://wxt.dev/) — Web extension framework
- React 19 + Valtio — UI and state management
- [Base UI](https://base-ui.com/) — Headless UI components (Tooltip, Select, ScrollArea, Collapsible)
- Tailwind CSS 4 — Styling
- Lucide React — Icons

## Development

```bash
# Install dependencies (from monorepo root)
yarn install

# Start dev mode (watches for changes, but runner is disabled — load manually)
yarn workspace @paplico/webgpu-devtools dev

# Build for Chrome
yarn workspace @paplico/webgpu-devtools build

# Build for Firefox
yarn workspace @paplico/webgpu-devtools build:firefox

# Package as zip
yarn workspace @paplico/webgpu-devtools zip

# Type check
yarn workspace @paplico/webgpu-devtools typecheck
```

### Loading the extension

1. Run `yarn workspace @paplico/webgpu-devtools build`
2. Open `chrome://extensions/`, enable Developer mode
3. Click "Load unpacked" and select `.output/chrome-mv3/`
4. Open DevTools on any page using WebGPU — the **WebGPU** tab appears

### Project structure

```
src/
├── components/              # Shared UI components
│   ├── InfoTooltip.tsx      # Base UI Tooltip wrapper with Info icon
│   ├── ScrollArea.tsx       # Base UI ScrollArea wrapper
│   └── Select.tsx           # Base UI Select wrapper
├── entrypoints/
│   ├── injected.ts          # WebGPU API interceptor (MAIN world)
│   ├── bridge.content.ts    # Content script message relay
│   ├── background.ts        # Service worker message router
│   ├── devtools/            # DevTools panel registration
│   └── devtools-panel/      # React DevTools UI
│       ├── App.tsx           # Main app with tab navigation
│       ├── store.ts          # Valtio state
│       ├── hooks/            # useDevToolsConnection, usePersistedState
│       └── components/       # Feature panels (Device, Resource, Texture, Buffer, Shader, Command, Frame, Memory, Capture, Error, Relations)
└── types.ts                 # Shared message and data types
```
