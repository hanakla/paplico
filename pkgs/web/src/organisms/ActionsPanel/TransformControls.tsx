import type { ElementTransform } from "@paplico/core/schema";
import {
	FlipHorizontal2,
	FlipVertical2,
	Italic,
	type LucideIcon,
	RotateCw,
} from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoCommands, usePaplicoStore } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
/** Shear input clamp: tan() blows up approaching ±90°. */
const MAX_SKEW_DEG = 89;

/**
 * Numeric transform editing in the ActionsPanel: rotation / skew of the
 * selected element(s), plus horizontal / vertical flips of the whole selection
 * around its bounds center. Paired values (skew) share one row. Values show
 * the first selected element's transform; edits patch the field on every
 * selected element, each turning around the centre of its own bounds. Scrub
 * the numbers to adjust; hold Ctrl for fine steps.
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

	const updateTransform = (field: keyof ElementTransform, value: number) => {
		commands.updateElementTransforms(
			store.selectedElementIds.flatMap((elementId) => {
				const element = store.document.objects[elementId];
				if (!element) return [];
				return [
					{ elementId, transform: { ...element.transform, [field]: value } },
				];
			}),
		);
	};

	const flipSelection = (flip: { x: boolean; y: boolean }) => {
		commands.flipElements(store.selectedElementIds, flip);
	};

	const handleRotationChange = useEventCallback((degrees: number) => {
		updateTransform("rotation", degrees * DEG_TO_RAD);
	});
	const handleSkewXChange = useEventCallback((degrees: number) => {
		updateTransform("skewX", degrees * DEG_TO_RAD);
	});
	const handleSkewYChange = useEventCallback((degrees: number) => {
		updateTransform("skewY", degrees * DEG_TO_RAD);
	});
	const handleFlipHorizontal = useEventCallback(() => {
		flipSelection({ x: true, y: false });
	});
	const handleFlipVertical = useEventCallback(() => {
		flipSelection({ x: false, y: true });
	});

	if (!first) return null;
	const transform = first.transform;

	return (
		<div className="flex flex-col gap-1.5 w-full">
			<div className="flex items-center px-1">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
					{t("actionsPanel.transform")}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
				<div className="flex items-center gap-1.5">
					<RowLabel
						icon={RotateCw}
						label={t("actionsPanel.transformRotation")}
					/>
					<NumInput
						step={1}
						unit="°"
						value={round2(transform.rotation * RAD_TO_DEG)}
						onChange={handleRotationChange}
					/>
				</div>
				<div className="flex items-center gap-1.5">
					<RowLabel icon={Italic} label={t("actionsPanel.transformSkew")} />
					<div className="flex items-center gap-3">
						<NumInput
							step={1}
							min={-MAX_SKEW_DEG}
							max={MAX_SKEW_DEG}
							unit="°"
							value={round2((transform.skewX ?? 0) * RAD_TO_DEG)}
							onChange={handleSkewXChange}
						/>
						<NumInput
							step={1}
							min={-MAX_SKEW_DEG}
							max={MAX_SKEW_DEG}
							unit="°"
							value={round2((transform.skewY ?? 0) * RAD_TO_DEG)}
							onChange={handleSkewYChange}
						/>
					</div>
				</div>
				<div className="flex items-center gap-1">
					<Tooltip
						content={t("actionsPanel.transformFlipHorizontal")}
						side="bottom"
					>
						<IconButton
							$size="xs"
							$variant="ghost"
							onClick={handleFlipHorizontal}
						>
							<FlipHorizontal2 size={14} />
						</IconButton>
					</Tooltip>
					<Tooltip
						content={t("actionsPanel.transformFlipVertical")}
						side="bottom"
					>
						<IconButton
							$size="xs"
							$variant="ghost"
							onClick={handleFlipVertical}
						>
							<FlipVertical2 size={14} />
						</IconButton>
					</Tooltip>
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
	const handleChange = useEventCallback((input: string | undefined) => {
		const parsed = Number(input);
		if (Number.isFinite(parsed)) onChange(parsed);
	});

	return (
		<FakeInput
			type="number"
			$size="xs"
			step={step}
			min={min}
			max={max}
			unit={unit}
			value={String(value)}
			onChange={handleChange}
			className="tabular-nums"
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
