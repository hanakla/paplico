import * as Sentry from "@sentry/nextjs";
import { toastManager } from "@/components/Toast";
import { isPaplicoError, type PaplicoErrorCode } from "@/core";
import { type LocalizeKeys, translateStatic } from "@/locales";
import {
	type NotificationAction,
	showBanner,
	showFatal,
} from "@/stores/notificationStore";

export type AppErrorCode =
	| PaplicoErrorCode
	| "AUTOSAVE_FAILED"
	| "EXPORT_FAILED"
	| "IMPORT_FAILED"
	| "DOCUMENT_OPEN_FAILED"
	| "DOCUMENT_CREATE_FAILED"
	| "ROOM_CREATE_FAILED"
	| "PAPLICO_INIT_FAILED";

interface ReportErrorOptions {
	code: AppErrorCode;
	/** Original thrown value, forwarded to console and Sentry */
	cause?: unknown;
	/** `{{param}}` interpolation values for the localized texts */
	params?: Record<string, string | number>;
	/** @default "toast" */
	channel?: "toast" | "banner" | "fatal";
	/** Toast styling only. @default "error" */
	severity?: "info" | "warning" | "error";
	action?: NotificationAction;
	/** Set false to skip Sentry capture (e.g. expected user-facing failures). @default true */
	capture?: boolean;
}

/**
 * Single entry point for user-visible error reporting.
 * Logs, captures to Sentry (rate-limited per code), resolves i18n keys,
 * then routes to the toast / banner / fatal channel.
 */
export function reportError(options: ReportErrorOptions): void {
	const { code, cause, params, severity, action } = options;

	console.error("[reportError]", code, cause);

	if (options.capture !== false) captureToSentry(code, cause);

	const { titleKey, descriptionKey } = ERROR_TEXTS[code];

	switch (options.channel ?? "toast") {
		case "toast": {
			const now = Date.now();
			const last = lastToastedAt.get(code);
			if (last !== undefined && now - last < TOAST_DEDUP_INTERVAL_MS) return;
			lastToastedAt.set(code, now);

			toastManager.add({
				title: translateStatic(titleKey, params),
				description: descriptionKey
					? translateStatic(descriptionKey, params)
					: undefined,
				type: severity ?? "error",
				timeout: ERROR_TOAST_TIMEOUT_MS,
				actionProps: action
					? {
							children: translateStatic(action.labelKey),
							onClick: action.onClick,
						}
					: undefined,
			});
			return;
		}
		case "banner": {
			showBanner({ key: code, titleKey, descriptionKey, action });
			return;
		}
		case "fatal": {
			showFatal({ code, titleKey, descriptionKey });
			return;
		}
	}
}

/** Resolve a caught value to an AppErrorCode, using PaplicoError's code when present. */
export function codeFromError(
	error: unknown,
	fallback: AppErrorCode,
): AppErrorCode {
	return isPaplicoError(error) ? error.code : fallback;
}

const SENTRY_CAPTURE_INTERVAL_MS = 60_000;
const TOAST_DEDUP_INTERVAL_MS = 5_000;
const ERROR_TOAST_TIMEOUT_MS = 8_000;

const lastCapturedAt = new Map<AppErrorCode, number>();
const lastToastedAt = new Map<AppErrorCode, number>();

/** i18n keys per error code. Every key must exist in locales/en.ts and ja.ts. */
const ERROR_TEXTS: Record<
	AppErrorCode,
	{ titleKey: LocalizeKeys; descriptionKey?: LocalizeKeys }
> = {
	PAPF_INVALID_FILE: { titleKey: "errors.papfInvalidFile" },
	PAPF_UNSUPPORTED_VERSION: { titleKey: "errors.papfUnsupportedVersion" },
	PAPF_CORRUPTED: { titleKey: "errors.papfCorrupted" },
	PAPF_MISSING_FILE_ENTRY: { titleKey: "errors.papfMissingFileEntry" },
	WEBGPU_UNSUPPORTED: {
		titleKey: "errors.webgpuUnsupported",
		descriptionKey: "errors.webgpuUnsupportedDescription",
	},
	WEBGPU_INIT_FAILED: { titleKey: "errors.webgpuInitFailed" },
	WEBGPU_DEVICE_LOST: { titleKey: "errors.webgpuDeviceLost" },
	AUTOSAVE_FAILED: {
		titleKey: "errors.autosaveFailed",
		descriptionKey: "errors.autosaveFailedDescription",
	},
	EXPORT_FAILED: { titleKey: "errors.exportFailed" },
	IMPORT_FAILED: { titleKey: "errors.importFailed" },
	DOCUMENT_OPEN_FAILED: { titleKey: "errors.documentOpenFailed" },
	DOCUMENT_CREATE_FAILED: { titleKey: "errors.documentCreateFailed" },
	ROOM_CREATE_FAILED: { titleKey: "connectRoomDialog.roomCreateFailed" },
	PAPLICO_INIT_FAILED: { titleKey: "errors.paplicoInitFailed" },
};

function captureToSentry(code: AppErrorCode, cause: unknown): void {
	const now = Date.now();
	const last = lastCapturedAt.get(code);
	if (last !== undefined && now - last < SENTRY_CAPTURE_INTERVAL_MS) return;
	lastCapturedAt.set(code, now);

	Sentry.captureException(cause ?? new Error(code), {
		tags: { errorCode: code },
		fingerprint: ["{{ default }}", code],
	});
}
