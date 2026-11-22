import type { Migration } from "./index";

/** The `type` a 3D scene element was stored under before it became "scene3d". */
export const LEGACY_SCENE3D_TYPE = "reference3d";

/**
 * The document field, papf metadata field and Yjs root map that held the
 * shared 3D scene definitions before they became `scenes3d`.
 */
export const LEGACY_SCENES3D_KEY = "references3d";

/**
 * Renames the stored `type` of 3D scene elements to "scene3d". The scene
 * definitions are renamed where they are read, because they sit outside
 * `Document.objects`: the papf reader and the Yjs extraction both take
 * LEGACY_SCENES3D_KEY for `scenes3d`.
 */
export const migScene3DRename: Migration = {
	version: 20261122,
	migrate(doc): void {
		for (const element of Object.values(doc.objects)) {
			const stored: { type: string } = element;
			if (stored.type === LEGACY_SCENE3D_TYPE) stored.type = "scene3d";
		}
	},
};
