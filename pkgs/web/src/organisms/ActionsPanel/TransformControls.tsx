import { Italic, type LucideIcon, RotateCw } from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { FakeInput } from "@/components/FakeInput";
import { usePaplicoCommands, usePaplicoStore } from "@/contexts/PaplicoContext";
import type { ElementTransform } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
/** Shear input clamp: tan() blows up approaching ±90°. */
const MAX_SKEW_DEG = 89;

/**
 * Numeric transform editing in the ActionsPanel: rotation / scale / skew of the
 * selected element(s). Paired values (scale, skew) share one row. Values show
 * the first selected element's transform; edits patch the field on every
 * selected element (same `updateElement` path the tools commit through, so
 * undo/locks/sync behave identically). Scrub the numbers to adjust; hold Ctrl
 * for fine steps.
 */
export const TransformControls = memo(function TransformControls() {
	const t = useTranslation();
	const commands = usePaplicoCommands();
	const store = usePaplicoStore();
	const snap = useSnapshot(store);

	const selected = snap.selectedElementIds
		.map((id) => snap.document.objects[id])
		.filter((el) => el !== undefined);
	const first = selected[0];

	const handleChange = useEventCallback(
		(field: keyof ElementTransform, value: number) => {
			const layerId = store.currentLayerId;
			if (!layerId) return;
			for (const id of store.selectedElementIds) {
				const element = store.document.objects[id];
				if (!element) continue;
				commands.updateElement(layerId, id, {
					transform: { ...element.transform, [field]: value },
				});
			}
		},
	);

	if (!first) return null;
	const transform = first.transform;

	return (
		<div className="flex flex-col gap-1.5 w-full">
			<div className="flex items-center px-1">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
					{t("actionsPanel.transform")}
				</span>
			</div>
			<div className="flex items-center gap-8 px-1">
				<div className="flex flex-1 justify-start items-center gap-1.5">
					<RowLabel
						icon={RotateCw}
						label={t("actionsPanel.transformRotation")}
					/>
					<NumInput
						step={1}
						unit="°"
						value={round2(transform.rotation * RAD_TO_DEG)}
						onChange={(v) => handleChange("rotation", v * DEG_TO_RAD)}
					/>
				</div>
				{/* Twice the share: it holds two inputs, so each stays the width
				    of the rotation one. */}
				<div className="flex flex-2 justify-start items-center gap-1.5">
					<RowLabel icon={Italic} label={t("actionsPanel.transformSkew")} />
					<NumInput
						step={1}
						min={-MAX_SKEW_DEG}
						max={MAX_SKEW_DEG}
						unit="°"
						value={round2((transform.skewX ?? 0) * RAD_TO_DEG)}
						onChange={(v) => handleChange("skewX", v * DEG_TO_RAD)}
					/>
					<NumInput
						step={1}
						min={-MAX_SKEW_DEG}
						max={MAX_SKEW_DEG}
						unit="°"
						value={round2((transform.skewY ?? 0) * RAD_TO_DEG)}
						onChange={(v) => handleChange("skewY", v * DEG_TO_RAD)}
					/>
				</div>
			</div>
		</div>
	);
});

// --- Helpers ---

function NumInput({
	value,
	onChange,
	step,
	min,
	max,
	unit,
}: {
	value: number;
	onChange: (value: number) => void;
	step: number;
	min?: number;
	max?: number;
	unit?: string;
}) {
	return (
		<FakeInput
			type="number"
			$size="xs"
			step={step}
			min={min}
			max={max}
			unit={unit}
			value={String(value)}
			onChange={(v) => {
				const parsed = Number(v);
				if (Number.isFinite(parsed)) onChange(parsed);
			}}
			className="flex-1 text-right tabular-nums"
		/>
	);
}

function RowLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
	return (
		<span
			className="text-muted-foreground shrink-0"
			role="img"
			title={label}
			aria-label={label}
		>
			<Icon size={14} />
		</span>
	);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
