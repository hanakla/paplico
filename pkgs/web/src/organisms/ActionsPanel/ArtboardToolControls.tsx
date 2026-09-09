import { memo, useEffect, useId, useState } from "react";
import { useSnapshot } from "valtio";
import { Input } from "@/components/Input";
import { usePaplico } from "@/contexts/PaplicoContext";
import { formatLength, unitToWorld } from "@/core/document/units";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

type DimensionField = "width" | "height" | "x" | "y";

const MIN_ARTBOARD_SIZE = 10;

/** Name and geometry editor for the artboard selected by the artboard tool. */
export const ArtboardToolControls = memo(function ArtboardToolControls() {
	const t = useTranslation();
	const { commands, uiState: store } = usePaplico();
	const snap = useSnapshot(store);
	const selectedArtboard = snap.document.artboards.find(
		(a) => a.id === snap.selectedArtboardId,
	);
	const units = snap.document.units;

	const [localValues, setLocalValues] = useState({
		name: "",
		width: "",
		height: "",
		x: "",
		y: "",
	});

	useEffect(() => {
		if (!selectedArtboard) return;
		setLocalValues({
			name: selectedArtboard.name,
			width: formatLength(selectedArtboard.width, units),
			height: formatLength(selectedArtboard.height, units),
			x: formatLength(selectedArtboard.x, units),
			y: formatLength(selectedArtboard.y, units),
		});
	}, [selectedArtboard, units]);

	const handleNameChange = useEventCallback((value: string) => {
		setLocalValues((prev) => ({ ...prev, name: value }));
	});

	const handleNameBlur = useEventCallback(() => {
		if (!snap.selectedArtboardId || !localValues.name.trim()) return;
		commands.updateArtboard(snap.selectedArtboardId, {
			name: localValues.name,
		});
	});

	const handleDimensionChange = useEventCallback(
		(field: DimensionField, value: string) => {
			setLocalValues((prev) => ({ ...prev, [field]: value }));
		},
	);

	const handleDimensionBlur = useEventCallback((field: DimensionField) => {
		if (!snap.selectedArtboardId || !selectedArtboard) return;

		const parsed = Number.parseFloat(localValues[field]);
		if (Number.isNaN(parsed)) {
			setLocalValues((prev) => ({
				...prev,
				[field]: formatLength(selectedArtboard[field], units),
			}));
			return;
		}

		const isSize = field === "width" || field === "height";
		const world = Math.max(
			unitToWorld(parsed, units),
			isSize ? MIN_ARTBOARD_SIZE : Number.NEGATIVE_INFINITY,
		);
		setLocalValues((prev) => ({
			...prev,
			[field]: formatLength(world, units),
		}));
		commands.updateArtboard(snap.selectedArtboardId, { [field]: world });
	});

	const handleKeyDown = useEventCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") e.currentTarget.blur();
		},
	);

	const inputId = useId();

	if (!selectedArtboard) {
		return (
			<p className="w-full text-[10px] text-muted-foreground text-center leading-tight">
				{t("actionsPanel.artboardSelectOrCreate")}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-2 w-full">
			<Input
				$size="xs"
				value={localValues.name}
				onChange={(e) => handleNameChange(e.target.value)}
				onBlur={handleNameBlur}
				onKeyDown={handleKeyDown}
			/>

			<div className="text-[10px] text-muted-foreground text-right leading-none">
				{units}
			</div>

			{(
				[
					["width", "height"],
					["x", "y"],
				] as const
			).map((row) => (
				<div key={row[0]} className="grid grid-cols-2 gap-1.5">
					{row.map((field) => (
						<div key={field} className="flex items-center gap-1">
							<label
								htmlFor={`${inputId}-${field}`}
								className="text-[10px] text-muted-foreground w-3 uppercase"
							>
								{field[0]}
							</label>
							<Input
								id={`${inputId}-${field}`}
								type="number"
								$size="xs"
								value={localValues[field]}
								onChange={(e) => handleDimensionChange(field, e.target.value)}
								onBlur={() => handleDimensionBlur(field)}
								onKeyDown={handleKeyDown}
								className="font-mono tabular-nums"
							/>
						</div>
					))}
				</div>
			))}
		</div>
	);
});
