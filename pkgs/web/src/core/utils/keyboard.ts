const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Strictly match a keyboard event against a key specification.
 * Returns true only when the exact specified keys are pressed and no others.
 *
 * @param e - The keyboard event
 * @param expectCode - KeyboardEvent.code string (e.g. "KeyA", "Digit0")
 * @param spec - Modifier keys to require. Unspecified modifiers default to false (must NOT be pressed).
 *   - `ctrlOrMetaKey`: metaKey on Mac, ctrlKey on other platforms
 *   - `metaKey`, `ctrlKey`, `altKey`, `shiftKey`: explicit modifier requirements
 */
export function matchKey(
	e: {
		code: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	},
	expectCode?: string | null,
	spec?: {
		ctrlOrMeta?: boolean;
		meta?: boolean;
		ctrl?: boolean;
		alt?: boolean;
		shift?: boolean;
	},
): boolean {
	if (expectCode != null && e.code !== expectCode) return false;

	const expectMeta = !!spec?.meta;
	const expectCtrl = !!spec?.ctrl;
	const expectAlt = !!spec?.alt;
	const expectShift = !!spec?.shift;

	let wantMeta = expectMeta;
	let wantCtrl = expectCtrl;

	if (spec?.ctrlOrMeta) {
		if (isMac) {
			wantMeta = true;
		} else {
			wantCtrl = true;
		}
	}

	if (
		e.metaKey !== wantMeta ||
		e.ctrlKey !== wantCtrl ||
		e.altKey !== expectAlt ||
		e.shiftKey !== expectShift
	)
		return false;

	return true;
}
