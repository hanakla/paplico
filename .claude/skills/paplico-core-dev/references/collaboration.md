# Collaboration & Undo/Redo Reference

## Why Yjs is the single source of truth

All document state lives in Yjs Y.Doc. The Valtio state that the renderer reads is a derived mirror, synced via outbound callbacks. This design exists because:

1. **CRDT conflict resolution** — Yjs automatically merges concurrent edits from multiple users without manual conflict handling
2. **Undo/redo for free** — UndoManager captures every Yjs mutation. Undo rolls back Y.Doc state, which triggers a sync to Valtio, which triggers a re-render. No separate undo stack needed
3. **Network-agnostic** — The same Y.Doc works for local-only, WebSocket, and PartyKit. The collaboration transport (`ICollaboration`) only syncs Y.Doc updates

## Two sync modes and why both exist

### Full sync

`extractDocumentFromYDoc` reads the entire Y.Doc and produces a fresh `Document` object. Used when:
- Layer structure changes (add/remove/reorder layers)
- Undo/redo (UndoManager may roll back structural changes)
- Initial document load
- Any change that can't be expressed as a simple object delta

Full sync is expensive — it rebuilds the entire Document from Yjs state. On a 1000-element document this takes ~5ms.

### Delta sync

`onObjectsChange` callback sends only the added/updated/deleted object IDs. The upper layer patches only those objects in the Valtio state. Used for:
- Normal element property changes (move, resize, color change)
- Any mutation that only touches `Document.objects` entries

Delta sync is ~100x cheaper than full sync for single-element edits. The YjsProvider tracks pending changes and decides which mode to use.

**When adding new synced state:** If it changes frequently (like element positions during drag), support delta sync. If it changes rarely (like layer structure), full sync is fine.

## UndoManager integration

UndoManager watches specific Y types: `yObjects`, `yLayers`, `yArtboards`, `yAnimation`. Changes are grouped into undo items with a 500ms capture timeout — rapid sequential edits become a single undo step.

Animation-origin transactions are excluded from the main undo stack (they have their own `animationUndoManager`). This prevents "undo" during animation editing from undoing drawing operations.

Stack events (`stack-item-added`, `stack-item-popped`) notify the UI to update undo/redo button states.

**When adding new persistent data that should be undoable:** Add the Y type to UndoManager's tracked roots array.

## ICollaboration and transport modes

Two implementations of `ICollaboration`:
- **Collaboration** (local mode) — y-websocket + custom WebSocket server
- **PartyKitCollaboration** (cloud mode) — y-partykit + Clerk JWT auth

`createCollaboration` factory selects based on environment config. Both provide: Y.Doc sync, Awareness API (cursor positions, user presence), room management (kick, close).

Adding a new collaboration transport: implement `ICollaboration` interface and update `createCollaboration`.

## What to change when adding new synced state

1. Add Y.Map or Y.Array to YjsProvider and CRUD methods
2. Add reading logic in `extractDocumentFromYDoc` (for full sync)
3. If frequently changing, add delta tracking to `pendingObjectChanges` (for delta sync)
4. If undoable, add Y type to UndoManager tracked roots
5. Test: create element → undo → redo should restore the state exactly
