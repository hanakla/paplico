import { memo, type ReactNode } from "react";
import type {
	BrushStroking,
	LineCap,
	LineJoin,
	StrokeAlign,
} from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { SimpleSelect } from "./SimpleSelect";
import { Slider } from "./Slider";

type StrokeGeometryFieldsProps = {
	/** Normalized stroking settings; undefined when the brush is not geometric. */
	stroking: BrushStroking | undefined;
	disabled?: boolean;
	/**
	 * Render the miter limit under the corner shape. It only applies to a
	 * miter corner, so panels that have no room for it leave it out.
	 */
	showMiterLimit?: boolean;
	onChange: (patch: Partial<BrushStroking>) => void;
};

/**
 * Line cap, corner shape and stroke placement, one setting per row. Emits
 * partial BrushStroking patches.
 */
export const StrokeGeometryFields = memo(function StrokeGeometryFields({
	stroking,
	disabled,
	showMiterLimit,
	onChange,
}: StrokeGeometryFieldsProps) {
	const t = useTranslation();

	const lineJoin = stroking?.lineJoin ?? "round";

	const handleLineCapChange = useEventCallback((value: string) => {
		onChange({ lineCap: value as LineCap });
	});

	const handleLineJoinChange = useEventCallback((value: string) => {
		onChange({ lineJoin: value as LineJoin });
	});

	const handleStrokeAlignChange = useEventCallback((value: string) => {
		onChange({ align: value as StrokeAlign });
	});

	const handleMiterLimitChange = useEventCallback((value: number) => {
		onChange({ miterLimit: value });
	});

	return (
		<div
			className="grid grid-cols-[1fr_6rem] items-center gap-x-2 gap-y-1"
			data-disabled={disabled || undefined}
		>
			<RowLabel>{t("filterPanel.lineCap")}</RowLabel>
			<SimpleSelect
				$size="xs"
				className="min-w-0"
				items={[
					{ label: t("filterPanel.capButt"), value: "butt" },
					{ label: t("filterPanel.capRound"), value: "round" },
					{ label: t("filterPanel.capSquare"), value: "square" },
				]}
				value={stroking?.lineCap ?? "round"}
				onValueChange={handleLineCapChange}
				disabled={disabled}
			/>

			<RowLabel>{t("filterPanel.joinType")}</RowLabel>
			<SimpleSelect
				$size="xs"
				className="min-w-0"
				items={[
					{ label: t("filterPanel.joinMiter"), value: "miter" },
					{ label: t("filterPanel.joinRound"), value: "round" },
					{ label: t("filterPanel.joinBevel"), value: "bevel" },
				]}
				value={lineJoin}
				onValueChange={handleLineJoinChange}
				disabled={disabled}
			/>

			{showMiterLimit && lineJoin === "miter" && (
				/* biome-ignore lint/a11y/noLabelWithoutControl: custom slider component */
				<label
					className="col-span-2 text-muted-foreground text-[10px] data-disabled:opacity-50"
					data-disabled={disabled || undefined}
				>
					<div>
						{t("filterPanel.miterLimit")}:{" "}
						{(stroking?.miterLimit ?? 4).toFixed(1)}
					</div>
					<Slider
						min={1}
						max={10}
						step={0.5}
						value={stroking?.miterLimit ?? 4}
						onValueChange={handleMiterLimitChange}
						disabled={disabled}
					/>
				</label>
			)}

			<RowLabel>{t("filterPanel.strokeAlign")}</RowLabel>
			<SimpleSelect
				$size="xs"
				className="min-w-0"
				items={[
					{ label: t("filterPanel.strokeAlignInside"), value: "inside" },
					{ label: t("filterPanel.strokeAlignCenter"), value: "center" },
					{ label: t("filterPanel.strokeAlignOutside"), value: "outside" },
				]}
				value={stroking?.align ?? "center"}
				onValueChange={handleStrokeAlignChange}
				disabled={disabled}
			/>
		</div>
	);
});

/** First grid column, so every row's control starts at the same x. */
function RowLabel({ children }: { children: ReactNode }) {
	return <span className="text-muted-foreground text-[10px]">{children}</span>;
}
