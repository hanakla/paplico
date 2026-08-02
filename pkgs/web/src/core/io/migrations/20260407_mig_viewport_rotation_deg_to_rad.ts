import type { Migration } from "./index";

export const migViewportRotationDegToRad: Migration = {
	version: 20260407,
	migrate(doc) {
		doc.viewport.rotation = (doc.viewport.rotation * Math.PI) / 180;
	},
};
