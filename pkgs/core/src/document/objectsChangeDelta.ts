import type { AnyArtObject } from "../schema";

/** Delta change information for objects */
export interface ObjectsChangeDelta {
	added: Map<string, AnyArtObject>;
	updated: Map<string, AnyArtObject>;
	deleted: Set<string>;
}
