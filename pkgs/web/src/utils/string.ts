/**
 * Convert full-width ASCII (！-～) and the ideographic space to their
 * half-width equivalents, e.g. to normalize search queries typed with a
 * Japanese IME.
 */
export function toHalfWidth(input: string): string {
	return input
		.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
		.replace(/　/g, " ");
}
