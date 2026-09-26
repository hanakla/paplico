import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	InMemoryCollaboration,
	InMemoryRoom,
} from "../testUtils/InMemoryCollaboration";
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

		it("should build the transport on the current Y.Doc", () => {
			const currentDoc = local.ydoc;
			const factory = vi.fn(
				(ydoc) => new InMemoryCollaboration(ydoc, { room }),
			);

			attachCollaboration(local, factory, "keepForRemote");

			expect(factory.mock.calls[0][0]).toBe(currentDoc);
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
