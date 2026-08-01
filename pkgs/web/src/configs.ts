// --- Auto-save timing ---

/** Default auto-save interval (ms) */
export const AUTO_SAVE_INTERVAL_MS = 60_000;

/** Extended interval for large documents (ms) */
export const AUTO_SAVE_SLOW_INTERVAL_MS = 300_000;

/** Threshold to detect slow saves and extend interval (ms) */
export const AUTO_SAVE_SLOW_THRESHOLD_MS = 1_000;

/** Max revisions kept per document */
export const AUTO_SAVE_MAX_REVISIONS = 20;

// --- Rasterization resolution ---

/** Base DPI that maps to 1x export scale (scale = dpi / BASE_DPI). */
export const BASE_DPI = 72;

/** DPI presets offered by the document filter-resolution and export selectors. */
export const RASTERIZATION_DPI_PRESETS: readonly number[] = [72, 144, 300];
