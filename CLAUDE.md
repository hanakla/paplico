# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paplico - an infinite canvas drawing application. Yarn 4 monorepo with workspaces in `pkgs/*`.

**📄 Detailed Specification:** See `specification.md` for comprehensive technical specifications, architecture details, WebGPU rendering pipeline, coordinate systems, data structures, and implementation guidelines.

## Response Policy

If you have not read CLAUDE.local.md yet, please read it first.

**CRITICAL: Always use the `mcp__now__now` tool at the start of EVERY response to get the current timestamp.**

**CRITICAL: When given an instruction by the user, reach agreement with the user on what the instruction means — using a diagram or other explanatory means — before starting work.**

**CRITICAL: Before starting work, take a somewhat critical stance toward the user's instruction and analyze the current situation.**

**CRITICAL: Never make linguistic errors. You have poor discrimination ability, and the user reads your text with extreme precision.**

### Instruction Misreading Recovery Protocol

**CRITICAL: You MUST read the user's instruction in full, word by word, before acting. Skimming and grabbing a single keyword is prohibited.**

**When the user says your interpretation is wrong:**

1. **Stop all action immediately.** Do not continue based on the current interpretation.
2. **Discard the current interpretation entirely.** Do not produce a variation. The first interpretation was wrong — its variations are also wrong.
   - When a method fails, return to "what is the goal" before trying variations of that method. Find a different route to achieve the goal.
3. **Re-read the user's original instruction literally, every single word.** Not a paraphrase. Not an inference. The actual words.
4. **Consider all possible meanings** before committing. If ambiguous, ask the user.
5. **State the new interpretation explicitly** and wait for confirmation before acting.

**Why this rule exists — a real incident:**

User: 「ツール切り替えたときに選択クリアしてない？」

The agent skimmed this instruction. It grabbed the word "選択" and, because the recent work context was gradient-related, jumped to "gradient stop selection". It also ignored "ツール切り替えたときに" entirely. Had the agent read the full sentence word by word, it would have understood: "When switching tools, element selection is being cleared (unintentionally)."

The user corrected the agent 4 times. Each time, instead of stopping to reconsider from scratch, the agent reflexively produced a minor variation of the same wrong interpretation:

- ❌ Attempt 1: "gradientSelectedStopIdがクリアされてない" — wrong subject AND wrong direction
- ❌ Attempt 2: Added gradient state clearing to `setCurrentTool` — still wrong subject, ignored user's correction
- ❌ Attempt 3: "element選択がクリアされていない" — fixed subject but still wrong direction
- ❌ Attempt 4 (finally correct): "element選択がクリアされてしまっている" → removed `onClearSelection()` from `GradientTool.onCancel`

This wasted the user's time so severely that the user was driven to hurl extreme personal insults at the agent — language so harsh it should never have been necessary. The agent's incompetence forced the user into expressing that level of frustration. The root cause was not reading the instruction fully.

**Root cause:** The agent did not read the full instruction. It skimmed, grabbed one keyword ("選択"), and ran with a reflexive interpretation.

**Indicators that you are stuck in a misinterpretation loop:**

- User's frustration escalates with each response
- You are producing minor variations of the same interpretation

**When you detect ANY of these: STOP. Re-read the FULL original instruction. Reconsider from scratch. Do NOT produce another variation.**

## Workflow & Task Management

**CRITICAL: Before asking what to do next, ALWAYS check:**

1. **Active TODO list** - Check if there's an active todo list from the TodoWrite tool
2. **`.claude/memos/progress.md`** - Review recent progress, completed tasks, and planned next steps
3. **Ask the user** - Only after checking the above, ask the user what they'd like to work on next

This ensures continuity and prevents losing context between sessions.

## Packages

- `pkgs/web` - Next.js 16 frontend with React 19, Tailwind CSS 4
  - **Drawing engine is located at `pkgs/web/src/core/`** (not in a separate package)
- `pkgs/desktop` - Tauri v2 desktop app wrapper (`@paplico/desktop`)
- `pkgs/syrup` - Syrup scripting language (`@paplico/syrup`): parser, type checker, JS emitter, worker sandbox and Monaco integration. Knows nothing about Paplico — see "Syrup Automation Scripting"
- `pkgs/avif-hdr` - AVIF HDR encode/decode (`@paplico/avif-hdr`)
- `pkgs/partykit-collab-server` - PartyKit server for cloud collaboration mode
- `pkgs/webgpu-devtools` - WXT browser extension for inspecting the WebGPU pipeline

## Commands

```bash
# Install dependencies (from root)
yarn install

# Start development (from root: Supabase + Next.js dev server on :5005 + Storybook on :6006 + PartyKit dev)
yarn dev

# Local Supabase management (from root)
yarn db:status / db:start / db:reset / db:stop

# Lint and auto-fix
yarn lint:fix

# type checking
yarn workspace pap typecheck

# Run all tests (from pkgs/web)
yarn workspace pap test

# Run a single test file
yarn workspace pap vitest run src/core/tools/PenTool.test.ts

# Run visual regression tests (VRT)
yarn workspace pap test:visual

# Update VRT snapshots
yarn workspace pap test:visual:update

# Check if dev server is running (from root)
yarn check-dev-server

# Report unused exports / public members (also runs on pre-push)
yarn lint:unused

# Syrup language package (from root)
yarn workspace @paplico/syrup test
yarn workspace @paplico/syrup vitest run src/host/host.test.ts
yarn workspace @paplico/syrup typecheck
yarn workspace @paplico/syrup playground   # Vite playground with the Monaco editor

# AVIF HDR package
yarn workspace @paplico/avif-hdr test
```

### Test Environment

- **Test runner:** Vitest 4 with `happy-dom` environment
- **Config:** `pkgs/web/vitest.config.ts`
- **Path alias:** `@/*` → `./src/*` (same as tsconfig)
- **Globals:** `describe`, `it`, `expect`, `vi` etc. available without import

## Server Management

The development server writes its PID to `pap.lock` at the project root when started. This allows for easy server management:

```bash
# Kill the running server using the lock file
kill $(cat pap.lock)

# Or force kill if needed
kill -9 $(cat pap.lock)

# The lock file is automatically cleaned up on graceful shutdown (SIGINT)
```

**CRITICAL: Before restarting the server, ALWAYS check if the process is actually running:**

```bash
# Use the check-dev-server script
yarn check-dev-server

# Or use the script directly
./scripts/check-dev-server
```

**Why this matters:**

- Exit code 137 typically means the process was killed by the system (OOM, timeout, etc.)
- The server may already be dead but the lock file remains
- Blindly restarting without checking wastes resources and causes confusion
- Always verify the PID is alive before attempting to kill or restart

**Note:** The `pap.lock` file is automatically created when `yarn dev` starts and removed when the server is stopped with Ctrl+C.

**CRITICAL: When the dev server is running, check which port the process in `pap.lock` is listening on:**

```bash
# Get the port the dev server is listening on
lsof -p $(cat pap.lock) -iTCP -sTCP:LISTEN -P | grep LISTEN
```

Use this to determine the correct port for browser automation and MCP tools instead of assuming a default port.

## Code Style

Principle: Minimal code, Minimal conditions, Minimal states, Minimal Side-effect(or Explicit Side-effect), Minimal changes, it gives Beautiful Minimal Architecture

- Uses Biome for linting/formatting (configured in `biome.json`)
  - Fix format by `yarn lint:fix`
- Tab indentation
- Double quotes for strings
- Auto-organize imports enabled
- **Do not duplicate type definitions. Reuse existing types, and if a type already exists in `schema.ts`, never redefine it elsewhere.**
- **Use lucide-react for all icons**
- Class methods must always declare an explicit access modifier (`public`, `protected`, or `private`).
- Use Tailwind v4 syntax for styling
  - Data attribute braces (`[]` in `data-[attr]`) not needed if data value specifier is nothing.
  - Var braces (ex: `origin-[var(--my-var)]`) write to `origin-(--my-var)` instead.
- **Use ES2024+ syntax aggressively:**
  - Prefer `Object.groupBy()` over manual grouping
  - Use logical assignment operators (`??=`, `||=`, `&&=`)
  - Use numeric separators for readability (`1_000_000`)
  - Prefer optional chaining (`?.`) and nullish coalescing (`??`)
  - Use `Array.prototype.at()` for negative indexing
  - Avoid unnecessary type assertions and verbose conditionals
- **Write all code comments in English. Don't write meaningless feature-advertising comments that provide no value when read later.**

### File Structure Rules

**CRITICAL: Organize code within files in the following order:**

**The "main" of a file determines what goes after it.** Helper functions, internal hooks, and utilities must be placed after the file's primary export (the main component, class, or function). In test files, helpers go after the test cases.
The key principle: a reader should encounter the file's purpose first, not its implementation details.

1. **Main types and interfaces** - Core data structures and type definitions
2. **Main classes and functions** - Primary business logic and exported APIs
   1. public property, private property / public methods
   2. private methods
3. **Helper functions and utilities** - Supporting functions used by main implementations

This top-down structure improves readability and helps readers understand the core purpose of a file before diving into implementation details.

Example:

```typescript
// 1. Main types first
export interface Tool {
	/* ... */
}
export type StrokePoint = {
	/* ... */
};

// 2. Main class/function
export class PenTool implements Tool {
	/* ... */
}

// 3. Helper functions at the end
function smoothStroke(points: StrokePoint[]) {
	/* ... */
}
function decimatePoints(points: StrokePoint[]) {
	/* ... */
}
```

## Writing User-Facing Docs (`src/app/docs/`)

`src/app/docs/` is written for people who use the app. `src/app/devdocs/` is written for people who work on the engine. Never mix the two registers. When writing or revising anything under `docs/`, apply the `/text-writing` skill and the rules below.

### Softness lives in nouns, not in sentence endings

Switching to ですます調 does not make text softer. Politeness markers sit in a different layer from the lexical density that readers perceive as stiffness. Rewrite the nouns:

- **Open nominalizations back into verb clauses.** A 漢語 noun hides its arguments, forcing the reader to reconstruct them.
  - ✗ 「同一性に関わる値」 → ✓ 「そのオブジェクトが何者かを決めている値」
- **Replace abstract nouns with concrete nouns plus spatial verbs**, so the sentence evokes an image.
  - ✗ 「実体を持ちません」 → ✓ 「ドキュメントの本物は置いてありません」
- **Swap worn-out 漢語 metaphors for live 和語 ones**, and prefer the transitive/potential form when someone actually acted.
  - ✗ 「経路は塞がります」 → ✓ 「この抜け道はふさげます」

### Do not carry implementer vocabulary into user docs

A word you read every day looks like a plain word. It is not. Before shipping, check for terms only the implementer uses.

- ✗ `~/.ssh`, `/tmp`, Web Worker, スレッド, メインスレッド, 絶対パス / 相対パス, OS のダイアログ, UTF-8, バイト列, 識別子, ラスタライズ
- ✓ 「見られたくない書類」「キャンバスとは切り離された場所」「アプリ本体」「`/` から始まる書き方」「いつものファイルを選ぶ画面」「画像として書き出すときの細かさ」
- Keep only the words the reader actually types: API names, `if let`, `await`, `nil`, type names. Renaming those breaks the match against completions and error messages.
- When a term has no everyday equivalent, fence the concept with examples and contrast instead of teaching the term.
  - ✗ 「バイト列を書くとき」 → ✓ 「画像など、文字以外を書くとき」
- Headings and table cells are subject to the same check. A table cell that merely restates the term explains nothing.
  - ✗ 「作業色空間とプルーフ意図」 → ✓ 「色の扱いかたの設定」

### One vocabulary complaint means there are more

Being told about a single word is a report about a habit, not about that word. Grep the whole document for the same pattern before replying; fixing the one instance and reporting done will draw the same complaint again. Apply to word choice the same verification you apply to facts.

## Codebase Exploration

- **When available, use Serena tool for codebase exploration**
  - \*\*\*Must: Call `activate_project` for each begging of session
  - Serena provides advanced semantic search and code navigation capabilities
  - Prefer Serena over manual file searching when exploring unfamiliar code
  - Use Serena to understand relationships between components and call chains

## Debugging

- **Use chrome-devtools MCP for debugging:**
  - Available MCP tools: `mcp__chrome-devtools__*`
  - Take snapshots, evaluate scripts, inspect network requests
  - Debug WebGPU rendering issues directly in browser
  - Monitor Yjs collaboration WebSocket connections
- **CRITICAL: During browser automation for verification, do NOT output any text unless an error occurs.** Just execute the browser operations silently.
- **CRITICAL: Before adding debug code, clearly state:**
  - (1) the hypothesis you're testing,
  - (2) why that specific information is needed, and
  - (3) how the results will help isolate the root cause.
    No random console.log spam.
- **Remove debug code immediately after use.** Don't leave console.log spam in the codebase.
- **Trust the user when they say they reloaded the page.** Don't question whether they actually did - they are more reliable than you.

### Performance Profiling Cycle

Render performance is measured with the built-in perf check (`src/devtools/perfCheck.ts`). It patches the WebGPU device and render pipeline for 10 seconds, records render passes / draws / GPU timestamps / CPU method timings, then restores all patches.

The cycle:

1. **Ask the user to run a measurement** — Development menu → "Run Perf Check (10s)" (dev builds only), then interact with the canvas during the window (pan/zoom, edit, etc. — the per-window `activity` field records what happened). Do not drive the browser yourself.
2. **Read the result JSON** — it is auto-POSTed to `/api/dev/perf-result` and saved as `pkgs/web/perf-results/perf-<timestamp>.json` (gitignored). The same JSON is also printed to the browser console.
3. **Analyze** — start from `fps` and `topGpu` / `topCpu`, then drill into `passesPerRender`, `drawsPerRender`, `emptyPassesPerRender`, `copiesPerRender`, and `passOriginsPerRender` (JS call sites per pass). Per-2s `windows` separate idle from interaction phases; `coverage` tells how many passes actually got GPU timestamps.
4. **Change code, re-measure, compare** — keep the previous JSON and compare the same activity windows against the new run. Judge improvements by the measured numbers, never by impression.

### Technology Stack

**Frontend:**

- WebGPU for rendering (no fallback to Canvas API)
- Valtio for all reactive state (document data, tool settings, UI state, app settings)
- Yjs (CRDT) for real-time collaboration with automatic conflict resolution
- y-undo for undo/redo functionality
- Syrup (`@paplico/syrup`) + Monaco for user automation scripts, executed in a Web Worker sandbox

**Backend (two collaboration modes):**

- **Local mode** (default): Custom WebSocket server (`pkgs/web/server.mjs`) + `y-websocket`
- **Cloud mode** (`NEXT_PUBLIC_COLLAB_MODE=cloud`): PartyKit (`y-partykit`) + Supabase session JWT authentication
- CBOR format for import/export

### Core Concepts

**Rendering Architecture:**

The renderer is split into layered modules under `core/renderer/`:

```
Paplico (facade) → RenderOrchestrator → CanvasLayer (document layer, renderer/canvas/)
                                      → UILayer     (UI overlay layer, renderer/ui/)
                                             ├── ViewportManager    (uniform buffer, transform state)
                                             ├── DocumentCache      (document-cache blit)
                                             ├── ElementRenderer    (element dispatch, renderer/canvas/elements/)
                                             ├── CompositeRenderer  (texture blit, blend compositing)
                                             └── OffscreenPresenter (offscreen passes, clip groups)
```

- **RenderOrchestrator** — Owns the GPU device, manages multiple CanvasTargets, dispatches render calls. External code accesses rendering only through Paplico facade methods.
- **CanvasLayer** — Per-canvas document rendering pipeline. Manages render passes, stencil textures, and orchestrates the internal graphics machinery in `renderer/canvas/pipeline/`. Its peer UILayer (`renderer/ui/`) renders tool overlays in the same encoder pass; each layer owns its GPU pipelines.
- **DocumentCache** — Document-cache texture management. Tracks dirty layers, renders to cache textures, blits cached content to avoid re-rendering unchanged layers.
- **ElementRenderer** — Dispatches rendering for each element type (path stroke/fill, image, text, group, compound path). Type-specific renderers live in `renderer/canvas/elements/`.
- **CompositeRenderer / OffscreenPresenter** — Handle offscreen render passes for blend modes, clip groups, and rotation-corrected blit operations.

Viewport uniform buffer management uses three methods:

- `setViewportUniforms` — Updates GPU buffer + viewportState atomically
- `writeViewportUniformsToGPU` — GPU buffer only (for temporary overrides like offscreen passes)
- `restoreViewportUniformsToGPU` — Re-syncs GPU buffer from viewportState

Key rendering strategies:

- Viewport-based rendering (only render visible area)
- Viewport culling for off-screen elements
- Layer texture caching with dirty flag for incremental updates
- Separate `queue.submit` per uniform buffer state change (WebGPU reads uniforms at submit time)

**Data Structure:**

Defined in `pkgs/web/src/core/schema.ts`.

- `Document` contains layers, viewport, embedded files, and artboards
- `Layer` contains elements array
- `Element` = Path | Group | ImageObject | CompoundPath | TextElement
- All Element types extend `ArtObject` (common base interface with id, opacity, blendMode, rotation, visible, locked, filters, strokeColor, fill, brushSettings)

**Tool Architecture:**
All drawing tools implement the `Tool` interface with pointer event handlers:

- `onPointerDown/Move/Up` for input handling
- `onDoubleClick` (optional) for double-click handling
- `onKeyDown` (optional) for keyboard input
- `onCancel` for cancellation
- `getCursor` for cursor display
- **Testing:** Only test user-facing scenarios. Don't test internal implementation details.

**Real-time Collaboration:**

- Two modes switchable via `NEXT_PUBLIC_COLLAB_MODE` env var:
  - `local` (default): `Collaboration` class using `y-websocket` + custom `server.mjs`
  - `cloud`: `PartyKitCollaboration` class using `y-partykit` + Supabase session JWT auth
- `createCollaboration()` factory in `core/collaboration/` selects implementation
- `ICollaboration` interface abstracts both modes
- Yjs CRDT handles automatic conflict resolution
- Awareness API for cursor positions and user presence
- Local echo for immediate feedback
- Operation batching to reduce network load

**Undo/Redo System:**

- **CRITICAL:** All document mutations (add/update/delete elements, layers, filters) MUST go through YjsProvider methods
- Never mutate Valtio state directly for document data - always use YjsProvider
- Data flow: User action → YjsProvider.method() → Yjs updates → syncYjsToValtio → Valtio → React re-render
- When adding new entity types (Element, Layer, Filter, etc.), ensure corresponding YjsProvider methods exist and are used
- Use immutable updates: create new arrays/objects instead of mutating existing ones (e.g., `[...existing, newItem]` not `existing.push(newItem)`)
- UndoManager tracks changes via `stack-item-added`/`stack-item-popped` events → `updateUndoRedoState()` updates UI

**Syrup Automation Scripting:**

User automations are written in Syrup (`.syrup`), a statically typed Swift-flavored language that compiles to JavaScript. `pkgs/syrup/specification.md` is the language reference; `pkgs/syrup/README.md` summarizes the feature set.

The package is a self-contained compiler + sandbox and **must stay Paplico-agnostic** — every host API arrives as an injected declaration plus a runtime binding, never as a hardcoded import:

```
syntax/ (chevrotain parser → AST) → checker/ (bidirectional type check) → emit/ (JS)
host/ScriptHost   — compile / analyze / runTests, package registration, createWorkerRunner
runner/           — broker (main thread: real bindings + handle table) ⇄ executor (worker)
service/, monaco/ — LanguageService (completion, hover, signature, definition) + editor wiring
```

Scripts execute in a Web Worker: the worker holds only compiled code, and every host call becomes a `__host` RPC answered by `RunnerBroker` on the main thread. Object identity crosses that boundary as handles (`runner/marshal.ts`), so script-visible objects are proxies, not live engine objects.

The Paplico-specific half lives in `pkgs/web/src`:

- `scripting/api.ts` — `PAPLICO_SCRIPTING_DECLARATIONS` (the Syrup type declarations the script sees) and `registerPaplicoScriptingApi`. **Declarations and runtime bindings must be added together here**, or the checker and the runtime disagree.
- `scripting/dom.ts` — `PaplicoAutomationDom`, the bridge that turns those bindings into `PaplicoCommands` / `PaplicoSelection` calls. Document mutations from scripts still go through commands (and therefore YjsProvider), so undo works normally.
- `scripting/runtime.ts` — `createPaplicoAutomationRuntime`: one running script at a time, 60s timeout, `stdout` and `prompt` callbacks supplied by the UI.
- `scripting/worker.ts` — the worker entry (`installWorkerRuntime()` from `@paplico/syrup/worker`).
- `automation/` — script catalog: `builtins.ts` (read-only sample scripts) and `repository.ts` (user scripts in localStorage, manageable only where `canManageUserScripts` is true, i.e. the Tauri build). UI is `dialogs/AutomationDialog.tsx` + `AutomationCodeEditor.tsx`; script file access goes through `infra/automationFileSystem.ts`.

**Coordinate Systems:**

Paplico uses three coordinate systems:

1. **Screen Space** - Browser viewport coordinates
   - Origin: Top-left (0, 0)
   - Y-axis: Downward is positive
   - Unit: CSS pixels

2. **World Space** - Canvas-independent logical coordinates
   - Origin: Canvas center (0, 0)
   - Y-axis: Upward is positive (mathematical convention)
   - Unit: Logical pixels (zoom-independent)
   - Range: -∞ to +∞
   - Used for: Element storage, collaboration sync

3. **NDC (Normalized Device Coordinates)** - WebGPU shader input
   - Origin: Center (0, 0)
   - Y-axis: Upward is positive
   - Range: (-1, -1) to (1, 1)

**Coordinate Transformation:**

Implementation: `pkgs/web/src/core/utils/geometry/geometry.ts`

```typescript
// Screen → World (for input handling)
screenToWorld(screenX, screenY, viewport, canvasWidth, canvasHeight);

// World → Screen (for cursor display, UI overlay)
worldToScreen(worldX, worldY, viewport, canvasWidth, canvasHeight);

// World → NDC (for WebGPU rendering)
worldToNDC(worldX, worldY, viewport, canvasWidth, canvasHeight);
```

Key formulas:

- Screen to World: `world = viewport + (screen - center) / zoom` (with Y-axis flip)
- World to Screen: `screen = center + (world - viewport) * zoom` (with Y-axis flip)

**CRITICAL:** Always use world coordinates for data storage and sync. Screen coordinates are ephemeral and viewport-dependent.

### File Organization

**IMPORTANT: All drawing engine code lives in `pkgs/web/src/core/`**

**core/ root placement rule:** the core/ root holds only the Paplico facade family (`Paplico*.ts`), the public barrel (`index.ts`), the document schema (`schema.ts`), and `dev-hmr.ts`. Everything else lives in a role-named directory. Do not add new loose files to the core/ root.

```
pkgs/web/
├── server.mjs             # Custom dev/WebSocket server for Yjs collaboration (writes pap.lock)
└── src/
    ├── core/              # Drawing engine (main implementation)
    │   ├── index.ts           # Public API barrel (userland-facing surface)
    │   ├── dev-hmr.ts         # Dev-only HMR side effect (imported by index.ts)
    │   ├── Paplico.ts         # Main engine facade (public API boundary)
    │   ├── PaplicoCommands.ts # Command pattern for document operations
    │   ├── PaplicoSelection.ts # Selection state management
    │   ├── PaplicoTools.ts    # Tool settings accessors
    │   ├── PaplicoShortcuts.ts # Keyboard shortcut definitions
    │   ├── schema.ts          # Core data structures (Document, Layer, Element, Color, Filter)
    │   ├── document/          # Data-model support
    │   │   ├── factory.ts         # Default value factories (Color, Transform, Viewport)
    │   │   ├── constants.ts       # Zoom limits, sentinel IDs
    │   │   ├── rendererState.ts   # Valtio RendererState factory (createRendererState)
    │   │   └── SpatialIndex.ts    # Spatial indexing for hit testing (Quadtree)
    │   ├── brush/             # Brush definitions (GPU rendering is in renderer/canvas/pipeline/brush/)
    │   │   ├── presets.ts         # Builtin brush presets/files
    │   │   └── strokePreview.ts   # Brush preview scene builder
    │   ├── renderer/          # WebGPU rendering engine
    │   │   ├── RenderOrchestrator.ts  # Top-level orchestrator (device init, canvas targets, render dispatch)
    │   │   ├── RenderScheduler.ts     # requestAnimationFrame scheduling, dirty strategy
    │   │   ├── CanvasTarget.ts        # Canvas element wrapper (resize observer, viewport state)
    │   │   ├── DocumentChangeSubscriber.ts # Document change -> dirty notification
    │   │   ├── types.ts               # FrameRequest, UIOverlayState
    │   │   ├── PipelineFactory.ts     # Shared GPU pipeline construction helpers
    │   │   ├── canvas/        # Document render layer (CanvasLayer + its helpers/types)
    │   │   │   ├── pipeline/  # Internal graphics machinery (ViewportManager, DocumentCache, CompositeRenderer, OffscreenPresenter, FilterRenderer, RenderPlanner, TexturePool, ClipMaskAtlas)
    │   │   │   │   └── brush/ # Brush rendering (BrushRenderer, DabRenderer, RibbonRenderer, WetStrokeRenderer, DabEvaluator, BrushTextureManager) + shaders/
    │   │   │   ├── elements/  # Element renderers (ElementRenderer dispatch, Gradient/Image/Mesh/Text)
    │   │   │   └── caches/    # Render caches (geometry, gradient, stamp, stroke, stencil)
    │   │   ├── ui/            # UI render layer (UILayer: selection overlay, cursor, guides) + types.ts (UI overlay data types) + constants.ts (UI colors)
    │   │   ├── filters/       # Filter processors + their WGSL shaders + filterCatalog + userland type barrel (index.ts)
    │   │   ├── generators/    # Texture generators (gradient, mesh gradient, corner radius)
    │   │   ├── geometry/      # Stroke tessellation
    │   │   └── shaders/       # Shared pipeline WGSL shaders (filter-specific WGSL lives in filters/)
    │   ├── tools/             # Drawing tools (Pen, Path, Shape, Text, Select, Eraser, Gradient, MeshDeform, PathEdit, Artboard) + ToolContext (tool -> engine bridge) + TextToolController
    │   ├── collaboration/     # Yjs provider, ICollaboration, Collaboration, PartyKitCollaboration, createCollaboration
    │   ├── typography/        # Text system
    │   │   ├── fonts/         # Font loading (Google Fonts, Local Fonts, FontManager)
    │   │   ├── TextLayoutEngine.ts
    │   │   └── TextRenderer.ts
    │   ├── ui/                # DOM input handling (PaplicoUI: pointer/keyboard/wheel/drag events)
    │   ├── io/                # External format boundary
    │   │   ├── papf/          # papf (CBOR) document format reader/writer
    │   │   ├── export/        # Image export (PNG/AVIF/PSD)
    │   │   └── migrations/    # papf format migrations
    │   ├── assets/            # Brush texture assets (air-brush, pencil)
    │   ├── infra/             # Platform-dependent code the engine itself needs (clipboard, local font enumeration). Platform impls split via `.tauri.ts`/`.dom.ts` suffixes or dynamic import; this is the ONLY place under core/ allowed to touch `@tauri-apps/*` or branch on the runtime
    │   ├── timelapse/         # Timelapse recording/playback/export
    │   ├── testUtils/         # Shared test helpers (pointerEvent.ts, visualRegression.ts)
    │   └── utils/             # General helpers (color, emitter, keyboard, lang, svgImport, wgpu-utils)
    │       └── geometry/      # Geometry domain (bezierBool, bounds, geometry, meshGradient, pathOps, Quadtree, resize, segmentOps, strokeFitting)
    ├── app/               # Next.js 16 app directory
    ├── auth/              # Authentication utilities (Supabase session, OAuth providers, Tauri auth)
    ├── automation/        # Automation script catalog (builtin + user scripts, repository, shared types)
    ├── scripting/         # Syrup host integration: API declarations + runtime bindings (api.ts), Paplico bridge (dom.ts), runtime factory, worker entry
    ├── components/        # Reusable only UI components (Button, Slider, Dialog, etc.)
    ├── dialogs/           # Modal dialogs (SignInDialog, OAuth providers, etc.)
    ├── hooks/             # Domain-logic hooks ONLY (useUserSession, useFontPreview, etc.). Generic UI utility hooks go in utils/hooks.ts
    ├── infra/             # App-level platform-dependent infrastructure: native fs/dialog/path access, IndexedDB (documents, brush presets), Supabase, OS-installed resource enumeration (e.g. system ICC profiles). Tauri-vs-browser impls split via `.tauri.ts`/`.web.ts` suffixes or dynamic import. core/ business logic (color, renderer, tools, …) must NOT enumerate/read files itself — it receives bytes from here
    ├── locales/           # i18n translations (en.ts, ja.ts)
    ├── organisms/         # Page-level compositions (Canvas, Toolbar, LayerPanel, etc.)
    ├── contexts/          # React contexts (PaplicoContext)
    ├── stores/            # Valtio stores (documentStore, uiStore, appSettings)
    └── utils/             # App-level utilities (hooks.ts contains domain-independent hooks only, testDocument)
```

**Dependency Rules (CRITICAL):**

- **`core/` MUST NOT import from `stores/`, `components/`, `organisms/`, `contexts/`, or `app/`**
- `core/` is business logic layer - keep it framework-agnostic
- **Platform-dependent code (OS branching, Tauri vs browser, native `fs`/`dialog`/`path` access, `@tauri-apps/*` imports, OS-installed resource enumeration) MUST be isolated in an `infra/` directory** — `core/infra/` for what the drawing engine itself needs (clipboard, local fonts), `src/infra/` for app-level concerns (filesystem, IndexedDB, Supabase, system profile enumeration) — using `.tauri.ts`/`.dom.ts`/`.web.ts` file splits or dynamic import. Everything else in `core/` (color, renderer, tools, io, …) stays platform-agnostic: it never imports `@tauri-apps/*`, never branches on `IS_TAURI_ENV`, and never enumerates/reads files — it only receives bytes/values passed in from an `infra/` module
- Use callback/dependency injection pattern to communicate with upper layers
- Example: YjsProvider accepts callbacks instead of importing documentStore
- `stores/`, `components/`, `organisms/`, and `contexts/` can import from `core/`
- This ensures core logic is reusable and testable
- **Treat `core/` as a single library. Do NOT add exports to `core/index.ts` that don't need to be exposed to userland (outside `core/`).** Classes, functions, and types used only within core/ should be imported directly from their modules, not re-exported through the barrel.

## Tauri Desktop Build

`pkgs/desktop/` wraps the Next.js app as a native desktop app using Tauri v2. The Rust source lives in `pkgs/desktop/src-tauri/`.

### Browser vs Tauri branching variables

| Variable                   | Where defined                                 | Value in Tauri  | Purpose                                                                                           |
| -------------------------- | --------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `TAURI_BUILD`              | shell env                                     | `"1"`           | Set before Next.js build by Tauri CLI                                                             |
| `process.env.IS_TAURI_ENV` | `next.config.ts` (derived from `TAURI_BUILD`) | `"1"`           | Injected into Next.js `env` block                                                                 |
| `IS_TAURI_ENV`             | `pkgs/web/src/utils/platform.ts`              | `true`          | Exported boolean constant for runtime branching                                                   |
| `detectMacOSTauri()`       | `pkgs/web/src/utils/platform.ts`              | `true` on macOS | Checks `navigator.userAgent.includes("PaplicoDesktop")` — Tauri sets this UA in `tauri.conf.json` |
| `.tauri-mac` CSS class     | Set by `TauriInit.tsx` and `page.tsx`         | present         | Added to `<html>` when running on macOS in Tauri; used for layout tweaks like menu bar padding    |

**`IS_TAURI_ENV` is the primary branching flag.** Use it for all conditional logic between browser and Tauri environments.

### Build differences in Tauri mode (`TAURI_BUILD=1`)

- `output: "export"` (static HTML export instead of Next.js server)
- `images: { unoptimized: true }`
- Sentry is disabled (`withSentryConfig` is not applied)
- The following files are temporarily removed before `next build` and restored after (see `pkgs/web/scripts/build-tauri.sh`):
  - `src/proxy.ts`, `src/app/api/`, `src/app/auth/app/`, `src/instrumentation.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`

### FileSystem abstraction

`pkgs/web/src/infra/filesystem.ts` exports a `FileSystem` object that switches implementation based on `IS_TAURI_ENV`:

- **Tauri** (`TauriFS`): uses `@tauri-apps/plugin-dialog` (open dialog) and `@tauri-apps/plugin-fs` (read/write)
- **Browser** (`DomFS`): uses `showOpenFilePicker` / `FileSystemFileHandle`

### Tauri-specific initialization

`pkgs/web/src/app/TauriInit.tsx` runs on mount when `IS_TAURI_ENV` is true:

- Loads safe area insets CSS plugin (`@saurl/tauri-plugin-safe-area-insets-css-api`)
- Listens to Tauri's native drag-drop events and re-dispatches them as a `tauri-file-drop` DOM `CustomEvent` so `page.tsx` can handle them uniformly

### Commands

```bash
# Desktop dev (from pkgs/desktop — starts Tauri + Next.js together)
yarn workspace @paplico/desktop dev

# Desktop build
yarn workspace @paplico/desktop build

# iOS dev / build
yarn workspace @paplico/desktop dev:ios
yarn workspace @paplico/desktop build:ios
```

The `dev:tauri` script in `pkgs/web/package.json` reuses an already-running dev server (checks `pap.lock`) to avoid double-starting.

## Development Notes

- local development in `https://localhost:5005`
- default target branch is `dev`
- **NEVER use `cat` with the -A option** - it not available on macOS
- Prefer Pointer Events API over Mouse Events for pressure support
- Use Yjs Y.Array and Y.Map for all shared data structures
- Use CBOR for efficient binary serialization
- **CRITICAL: After modifying files, run `yarn lint:fix`, not `yarn biome` to format the files.**
- **Pull Requests must follow `.github/pull_request_template.md` with appropriate title and description with English**
- **When commenting on GitHub (PR reviews, issue comments, etc.), always prefix the comment body with `Claude:`**

### WebGPU Utilities

**Use `webgpu-utils` for uniform buffer management:**

Located at `pkgs/web/src/core/utils/wgpu-utils.ts`

```typescript
import { compileShaderModule } from "../../utils/wgpu-utils";

// Compile shader and get structured uniform views
const { module, uniformViews } = compileShaderModule(device, {
	label: "My Shader",
	code: SHADER_CODE,
});

// Use uniformViews for automatic padding/alignment
uniformViews.uniforms.set({
	resolution: [width, height],
	direction: [1.0, 0.0],
	radius: 5.0,
});

const buffer = device.createBuffer({
	size: uniformViews.uniforms.arrayBuffer.byteLength,
	usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(buffer, 0, uniformViews.uniforms.arrayBuffer);
```

### Component Props Type Definitions

**CRITICAL: Define props inline and reference original library types for union values:**

```typescript
// ✗ BAD: Separate type definition, copying union values
export type ContentProps = {
  side?: "top" | "bottom" | "left" | "right";
};

function PopoverContent({ side }: ContentProps) { ... }

// ✓ GOOD: Inline definition, reference original types
function PopoverContent({
  side = "bottom",
}: {
  side?: BUIPopover.Positioner.Props["side"];
}) { ... }
```

### React Hooks Best Practices

- **ALWAYS use `useEventCallback` instead of `useCallback`**
  - Located at `src/utils/hooks.ts`
  - Provides stable function reference that always calls the latest version
  - Prevents unnecessary re-renders and re-initializations
  - **DO NOT add functions created with `useEventCallback` to dependency arrays**
  - Example:

    ```typescript
    const handleClick = useEventCallback((value) => {
    	// This will always use the latest props/state
    	doSomething(value);
    });

    useEffect(() => {
    	// handleClick is stable, no need to add to deps
    	element.addEventListener("click", handleClick);
    	// eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Empty deps is correct here
    ```

## Testing

- **Write tests in BDD style.** Use `describe` for the subject under test and `it` for expected behaviors (e.g., `it("should return empty array when input is empty")`).
- When you execute test or lint, do not trim results uses `tail`, `head` or something like that.

## Tool Tests

Shared helpers are in `core/testUtils/pointerEvent.ts`.
It provides `ev()`, `testViewport`, `testCanvasWidth`, `testCanvasHeight`.

When writing tool tests, follow these rules:

1. **Import `ev()` and coordinate constants from the shared helper.**
   Define `createMockCallbacks()` locally per test file because callback types differ across tools.
   Only extract helpers to `testUtils/` when their signatures are identical across 2+ test files.

2. **Read the tool's `Options` / `Callbacks` type and include ALL non-optional properties in the mock.**
   Missing even one required callback causes runtime errors in `onPointerMove` etc.

3. **Do NOT test private methods via `(tool as any).method`.**
   When methods are moved or deleted during refactoring, these tests break immediately.
   Prefer behavioral tests through public API.
   If you need to test pure computation logic, extract it as a standalone utility function first.

4. **Design test cases as user operation scenarios.**
   Compose each test as a sequence of `onPointerDown` → `onPointerMove` → `onPointerUp`.
   Verify results by asserting callback arguments, not internal state.

5. **Fix coordinate system to `testViewport=(0,0,zoom=1)`, `canvas=800×600`.**
   screen(400,300) → world(0,0).
   Override viewport individually only for zoom≠1 tests.

6. **Recreate the tool with `new` in `beforeEach`.**
   Tools hold internal state; prevent leaks between tests.

7. **Assert callback arguments via `mock.calls`, not `toHaveBeenCalledWith`.**
   Matching all arguments with `toHaveBeenCalledWith` is brittle.
   Extract from `mock.calls[0][0]` and assert specific fields.
