import { createContext, memo, useContext, useMemo } from "react";
import {
	type SvgFilterInput,
	svgInputNodeRef,
	svgNodeRefInput,
} from "@/core/renderer/filters";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { SelectRow } from "./SelectRow";

/** Earlier nodes of the `svg:filter` graph a control sits in, selectable as inputs. */
export const SvgInputRefsContext = createContext<
	ReadonlyArray<{ id: string; label: string }>
>([]);

/**
 * Picks where an SVG filter primitive reads from. A two-input primitive
 * hides "previous" on one selector while the other holds it, since feeding
 * the same image to both inputs is never what the user means.
 */
export const SvgInputSelect = memo(function SvgInputSelect({
	labelKey,
	value,
	onChange,
	excludePrevious = false,
}: {
	labelKey: LocalizeKeys;
	value: SvgFilterInput;
	onChange: (input: SvgFilterInput) => void;
	excludePrevious?: boolean;
}) {
	const t = useTranslation();
	const refs = useContext(SvgInputRefsContext);
	const items = useMemo(
		() => [
			...[
				{ value: "previous", label: t("filterPanel.svgInputPrevious") },
				{
					value: "SourceGraphic",
					label: t("filterPanel.svgInputSourceGraphic"),
				},
				{ value: "SourceAlpha", label: t("filterPanel.svgInputSourceAlpha") },
			].filter((item) => !excludePrevious || item.value !== "previous"),
			...refs.map((ref) => ({
				value: svgNodeRefInput(ref.id),
				label: ref.label,
			})),
		],
		[t, excludePrevious, refs],
	);
	// A reference to a node that no longer exists reads as "previous".
	const ref = svgInputNodeRef(value);
	const current =
		ref !== null && !refs.some((r) => r.id === ref) ? "previous" : value;
	return (
		<SelectRow
			label={t(labelKey)}
			items={items}
			value={current}
			onValueChange={(v) => onChange(v as SvgFilterInput)}
		/>
	);
});
