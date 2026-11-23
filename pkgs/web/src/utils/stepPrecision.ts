/** Decimal places implied by `step` (e.g. 0.1 → 1, 0.01 → 2, 1 → 0). */
export function stepDecimals(step: number): number {
	return step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
}

/** Round a value to the precision implied by `step`. */
export function roundToStep(value: number, step: number): number {
	return Number(value.toFixed(stepDecimals(step)));
}
