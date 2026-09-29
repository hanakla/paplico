import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
import { LATEST_SCHEMA_VERSION } from "../io/migrations";
import type { MigrationContext } from "../io/migrations/context";
import { type Document, type ElementTransform, getTransform } from "../schema";
import {
	InMemoryCollaboration,
	InMemoryRoom,
} from "../testUtils/InMemoryCollaboration";
import { legacyPlace } from "../testUtils/legacyPlacement";
import { rectPath } from "../testUtils/svgFixtures";
import {
	applyTransformToPoint,
	composeTransforms,
} from "../utils/geometry/geometry";
import { attachCollaboration } from "./attachCollaboration";
import { extractDocumentFromYDoc } from "./extractDocumentFromYDoc";
import { YjsProvider, type YjsProviderCallbacks } from "./YjsProvider";

describe("attachCollaboration", () => {
	let room: InMemoryRoom;
	let remote: YjsProvider;
	let local: YjsProvider;

	beforeEach(() => {
		room = new InMemoryRoom();
		remote = new YjsProvider({ callbacks: createMockCallbacks() });
		local = new YjsProvider({ callbacks: createMockCallbacks() });
		new InMemoryCollaboration(remote.ydoc, { room, isOwner: true });
		remote.addLayer(createLayer("shared-layer"));
	});

	afterEach(() => {
		room.destroy();
	});

	describe("when joining with fromRemote", () => {
		it("should adopt only the room's layers", () => {
			local.addLayer(createLayer("local-layer"));

			attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"fromRemote",
			);

			const layerIds = extractDocumentFromYDoc(local.ydoc).layers.map(
				(layer) => layer.id,
			);
			expect(layerIds).toEqual(["shared-layer"]);
		});

		it("should build the transport on the fresh Y.Doc", () => {
			const outgoingDoc = local.ydoc;
			const factory = vi.fn(
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
			);

			attachCollaboration(local, factory, "fromRemote");

			const receivedDoc = factory.mock.calls[0][0];
			expect(receivedDoc).toBe(local.ydoc);
			expect(receivedDoc).not.toBe(outgoingDoc);
		});
	});

	describe("when joining with keepForRemote", () => {
		it("should keep the local layers", () => {
			local.addLayer(createLayer("local-layer"));

			attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"keepForRemote",
			);

			const layerIds = extractDocumentFromYDoc(local.ydoc).layers.map(
				(layer) => layer.id,
			);
			expect(layerIds).toContain("local-layer");
			expect(layerIds).toContain("shared-layer");
		});

		it("should list a layer held on both sides once after sync", () => {
			local.addLayer(createLayer("shared-layer"));

			const collab = attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"keepForRemote",
			);
			collab.emit("synced", true);

			const layerIds = extractDocumentFromYDoc(local.ydoc).layers.map(
				(layer) => layer.id,
			);
			expect(layerIds).toEqual(["shared-layer"]);
		});

		it("should migrate the room's content and leave the local content alone", async () => {
			// The room, stored before rooms carried a version, turns a group
			// around the child's own centre; the local document, at this
			// client's schema, holds the same shape already placed by the
			// current rule.
			const turned = { ...createIdentityTransform(), rotation: 0.5 };
			const remoteGroupId = addTurnedGroup(remote, "shared-layer", "r", turned);
			local.ydoc.getMap("meta").set("schemaVersion", LATEST_SCHEMA_VERSION);
			local.addLayer(createLayer("local-layer"));
			const localGroupId = addTurnedGroup(local, "local-layer", "l", turned);
			const onReady = vi.fn();

			const collab = attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"keepForRemote",
				{ onReady },
			);
			collab.emit("synced", true);

			await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
			const doc = extractDocumentFromYDoc(local.ydoc);
			expect(doc.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
			expect(getTransform(doc.objects.l)).toMatchObject({ x: 0, y: 0 });
			expect(getTransform(doc.objects[localGroupId])).toEqual(turned);
			// The room's child is placed where the old rule drew it.
			const placed = composeTransforms(
				getTransform(doc.objects[remoteGroupId]),
				getTransform(doc.objects.r),
			);
			const corner = { x: 90, y: -10 };
			const before = legacyPlace(corner, turned, { x: 100, y: 0 });
			const after = applyTransformToPoint(corner.x, corner.y, placed);
			expect(after.x).toBeCloseTo(before.x);
			expect(after.y).toBeCloseTo(before.y);
		});

		it("should build the transport on the current Y.Doc", () => {
			const currentDoc = local.ydoc;
			const factory = vi.fn(
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
			);

			attachCollaboration(local, factory, "keepForRemote");

			expect(factory.mock.calls[0][0]).toBe(currentDoc);
		});
	});

	describe("room schema", () => {
		it("should bring an unversioned room up to the latest schema once synced", async () => {
			const onReady = vi.fn();
			const collab = attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"fromRemote",
				{ onReady },
			);
			collab.emit("synced", true);

			await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
			expect(extractDocumentFromYDoc(local.ydoc).schemaVersion).toBe(
				LATEST_SCHEMA_VERSION,
			);
			expect(extractDocumentFromYDoc(remote.ydoc).schemaVersion).toBe(
				LATEST_SCHEMA_VERSION,
			);
		});

		it("should hand the room's document to the context preparation", async () => {
			const prepareMigrationContext = vi.fn<
				(doc: Document) => Promise<MigrationContext>
			>(async () => ({ textLayoutBounds: new Map() }));
			const collab = attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"fromRemote",
				{ prepareMigrationContext },
			);
			collab.emit("synced", true);

			await vi.waitFor(() =>
				expect(prepareMigrationContext).toHaveBeenCalledTimes(1),
			);
			const [doc] = prepareMigrationContext.mock.calls[0];
			expect(doc.layers.map((layer) => layer.id)).toEqual(["shared-layer"]);
		});

		it("should not report a connection dropped while the room was measured", async () => {
			const dropped = new AbortController();
			const prepareMigrationContext = vi.fn<
				(doc: Document) => Promise<MigrationContext>
			>(async () => {
				dropped.abort();
				return { textLayoutBounds: new Map() };
			});
			const onReady = vi.fn();
			const collab = attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"fromRemote",
				{ prepareMigrationContext, signal: dropped.signal, onReady },
			);
			collab.emit("synced", true);

			await vi.waitFor(() =>
				expect(prepareMigrationContext).toHaveBeenCalledTimes(1),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(onReady).not.toHaveBeenCalled();
			expect(extractDocumentFromYDoc(local.ydoc).schemaVersion).not.toBe(
				LATEST_SCHEMA_VERSION,
			);
		});

		it("should report a room written by a newer client and leave it alone", async () => {
			remote.ydoc
				.getMap("meta")
				.set("schemaVersion", LATEST_SCHEMA_VERSION + 1);
			const onRoomSchemaNewer = vi.fn();
			const onReady = vi.fn();

			const collab = attachCollaboration(
				local,
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
				"fromRemote",
				{ onRoomSchemaNewer, onReady },
			);
			collab.emit("synced", true);

			await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
			expect(onRoomSchemaNewer).toHaveBeenCalledTimes(1);
			expect(extractDocumentFromYDoc(local.ydoc).schemaVersion).toBe(
				LATEST_SCHEMA_VERSION + 1,
			);
		});
	});
});

function createMockCallbacks(): YjsProviderCallbacks {
	return {
		onDocumentUpdate: vi.fn(),
		onLayersUpdate: vi.fn(),
		getCurrentLayerId: vi.fn(() => null),
		setCurrentLayerId: vi.fn(),
	};
}

/**
 * A 20×20 square centred on (100, 0), grouped with a square on the origin,
 * inside a group placed by `transform`.
 */
function addTurnedGroup(
	provider: YjsProvider,
	layerId: string,
	pathId: string,
	transform: ElementTransform,
): string {
	provider.addElement(layerId, rectPath(pathId, { x: 100, y: 0 }, 20, 20, []));
	provider.addElement(
		layerId,
		rectPath(`${pathId}-origin`, { x: 0, y: 0 }, 20, 20, []),
	);
	const groupId = provider.groupElements(layerId, [pathId, `${pathId}-origin`]);
	if (!groupId) throw new Error("group should be created");
	provider.updateElement(layerId, groupId, { transform });
	return groupId;
}

function createLayer(id: string) {
	return {
		id,
		name: id,
		visible: true,
		locked: false,
		opacity: 1,
		elementIds: [],
	};
}
