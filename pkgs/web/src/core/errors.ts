/**
 * Coded errors thrown by the Paplico engine.
 *
 * App layers catch these and map `code` to user-facing messages;
 * core stays free of any i18n / presentation concerns.
 */

export type PaplicoErrorCode =
	| "PAPF_INVALID_FILE" // bad magic, too small
	| "PAPF_UNSUPPORTED_VERSION" // format/toc version newer than reader
	| "PAPF_CORRUPTED" // crc mismatch, decode failure, out-of-bounds
	| "PAPF_MISSING_FILE_ENTRY" // referenced embedded file not found
	| "WEBGPU_UNSUPPORTED" // navigator.gpu missing
	| "WEBGPU_INIT_FAILED" // adapter/device request failed
	| "WEBGPU_DEVICE_LOST"; // device lost, recovery failed

/** Error with a machine-readable {@link PaplicoErrorCode} for user-facing handling. */
export class PaplicoError extends Error {
	public readonly code: PaplicoErrorCode;

	public constructor(
		code: PaplicoErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "PaplicoError";
		this.code = code;
	}
}

/** Type guard narrowing an unknown caught value to {@link PaplicoError}. */
export function isPaplicoError(value: unknown): value is PaplicoError {
	return value instanceof PaplicoError;
}
