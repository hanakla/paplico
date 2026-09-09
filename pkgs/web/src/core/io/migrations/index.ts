import type { Document } from "../../schema";
import { migAppearanceFilters } from "./20260221_mig_appearance_filters";
import { migBrushSettings } from "./20260224_mig_brush_settings";
import { migTiltPoolingDefaults } from "./20260228_mig_tilt_pooling_defaults";
import { migBrushUidRename } from "./20260304_mig_brush_uid_rename";
import { migHdrEnabled } from "./20260331_mig_hdr_enabled";
import { migViewportRotationDegToRad } from "./20260407_mig_viewport_rotation_deg_to_rad";
import { migColorProfile } from "./20260613_mig_color_profile";
import { migDefs } from "./20260617_mig_defs";
import { migRasterizationDpi } from "./20260705_mig_rasterization_dpi";
import { migGradientStopMidpoint } from "./20260722_mig_gradient_stop_midpoint";
import { migBrushV2 } from "./20260803_mig_brush_v2";
import { migAppearancePresets } from "./20260906_mig_appearance_presets";
import { migUnits } from "./20260910_mig_units";

export interface Migration {
	/** Schema version date (YYYYMMDD) this migration upgrades TO */
	version: number;
	/** Apply migration to the document. Mutates in place. */
	migrate(doc: Document): void;
}

/** All migrations in chronological order (ascending by version) */
const migrations: Migration[] = [
	migAppearanceFilters,
	migBrushSettings,
	migTiltPoolingDefaults,
	migBrushUidRename,
	migHdrEnabled,
	migViewportRotationDegToRad,
	migColorProfile,
	migDefs,
	migRasterizationDpi,
	migGradientStopMidpoint,
	migBrushV2,
	migAppearancePresets,
	migUnits,
];

/**
 * Apply all pending migrations to a document.
 * Runs migrations whose version > doc.schemaVersion, then updates schemaVersion.
 */
export function applyMigrations(doc: Document): void {
	for (const mig of migrations) applyMigration(doc, mig);
}

/** Apply specified migration to a document (testing purpose mainly) */
export function applyMigration(doc: Document, mig: Migration): void {
	const currentVersion = doc.schemaVersion ?? 0;
	if (mig.version <= currentVersion) return;

	mig.migrate(doc);
	doc.schemaVersion = mig.version;
}
