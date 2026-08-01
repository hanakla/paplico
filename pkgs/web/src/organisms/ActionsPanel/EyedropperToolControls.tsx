import { memo } from "react";
import { useSnapshot } from "valtio";
import { Checkbox } from "@/components/Checkbox";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const EyedropperToolControls = memo(function EyedropperToolControls() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const toolSnap = useSnapshot(tools.state);

	const handleToggle = useEventCallback(
		(key: keyof typeof tools.state.eyedropperCopyTargets, checked: boolean) => {
			tools.state.eyedropperCopyTargets[key] = checked;
		},
	);

	return (
		<div className="flex flex-col gap-2 w-full">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.eyedropperCopyTargets")}
			</span>
			<div className="flex flex-col gap-1.5 px-1">
				<EyedropperCheckboxRow
					checked={toolSnap.eyedropperCopyTargets.stroke}
					onToggle={(v) => handleToggle("stroke", v)}
					label={t("actionsPanel.eyedropperStroke")}
				/>
				<EyedropperCheckboxRow
					checked={toolSnap.eyedropperCopyTargets.fill}
					onToggle={(v) => handleToggle("fill", v)}
					label={t("actionsPanel.eyedropperFill")}
				/>
				<EyedropperCheckboxRow
					checked={toolSnap.eyedropperCopyTargets.filters}
					onToggle={(v) => handleToggle("filters", v)}
					label={t("actionsPanel.eyedropperFilters")}
				/>
				<EyedropperCheckboxRow
					checked={toolSnap.eyedropperCopyTargets.appearance}
					onToggle={(v) => handleToggle("appearance", v)}
					label={t("actionsPanel.eyedropperAppearance")}
				/>
				<EyedropperCheckboxRow
					checked={toolSnap.eyedropperCopyTargets.fontStyle}
					onToggle={(v) => handleToggle("fontStyle", v)}
					label={t("actionsPanel.eyedropperFontStyle")}
				/>
			</div>
		</div>
	);
});

const EyedropperCheckboxRow = memo(function EyedropperCheckboxRow({
	checked,
	onToggle,
	label,
}: {
	checked: boolean;
	onToggle: (value: boolean) => void;
	label: string;
}) {
	return (
		<span className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
			<Checkbox checked={checked} onCheckedChange={(v) => onToggle(!!v)} />
			{label}
		</span>
	);
});
