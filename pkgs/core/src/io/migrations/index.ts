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
import { migFilterBackdropFlag } from "./20260917_mig_filter_backdrop_flag";
import { migCompoundPathPivot } from "./20260918_mig_compound_path_pivot";
import { migDropEraseMasks } from "./20260920_mig_drop_erase_masks";
import { migBlendEasing } from "./20260921_mig_blend_easing";
import { migSplitStrokeErasure } from "./20260925_mig_split_stroke_erasure";
import { migFontSourceLoader } from "./20260927_mig_font_source_loader";
import { migTransformOrigin } from "./20260929_mig_transform_origin";
import type { MigrationContext } from "./context";

export interface Migration {
	/** Schema version date (YYYYMMDD) this migration upgrades TO */
	version: number;
	/**
	 * The migration reads other elements to rewrite one, so it is only right
	 * on a whole document, never on an object lifted out of it.
	 */
	wholeDocument?: true;
	/**
	 * Apply migration to the document. Mutates in place. `context` carries
	 * what the migration cannot read off the document (see MigrationContext).
	 */
	migrate(doc: Document, context?: MigrationContext): void;
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
	migFilterBackdropFlag,
	migCompoundPathPivot,
	migDropEraseMasks,
	migBlendEasing,
	migSplitStrokeErasure,
	migFontSourceLoader,
	migTransformOrigin,
];

/** Schema version a document has once every migration ran. */
export const LATEST_SCHEMA_VERSION = Math.max(
	...migrations.map((mig) => mig.version),
);

/** Whether bringing a document up from `fromVersion` runs a whole-document migration. */
export function needsWholeDocumentMigration(fromVersion: number): boolean {
	return migrations.some(
		(mig) => mig.wholeDocument && mig.version > fromVersion,
	);
}

/**
 * Schema version a document stored without one is taken to be at. Yjs rooms
 * and clipboard payloads written before they carried a version were all
 * produced by clients at this version.
 */
export const UNVERSIONED_SCHEMA_BASELINE = 20260927;

/**
 * Apply all pending migrations to a document.
 * Runs migrations whose version > doc.schemaVersion, then updates schemaVersion.
 */
export function applyMigrations(
	doc: Document,
	context?: MigrationContext,
): void {
	for (const mig of migrations) applyMigration(doc, mig, context);
}

/** Apply specified migration to a document (testing purpose mainly) */
export function applyMigration(
	doc: Document,
	mig: Migration,
	context?: MigrationContext,
): void {
	const currentVersion = doc.schemaVersion ?? 0;
	if (mig.version <= currentVersion) return;

	mig.migrate(doc, context);
	doc.schemaVersion = mig.version;
}
