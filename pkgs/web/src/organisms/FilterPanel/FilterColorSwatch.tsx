import { useRef, useState } from "react";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { ColorSwatch } from "@/components/ColorSwatch";
import { Popover } from "@/components/Popover";
import type { Color } from "@/core/schema";
import { useEventCallback } from "@/utils/hooks";

/** "Label …… swatch" row; clicking the swatch opens the picker popover. */
export function FilterColorSwatch({
	label,
	color,
	onColorChange,
}: {
	label: string;
	color: Color;
	onColorChange: (color: Color) => void;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const handleToggle = useEventCallback(() => setOpen((value) => !value));

	return (
		<div className="flex items-center justify-between">
			<span className="text-muted-foreground text-xs">{label}</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<button
					ref={buttonRef}
					type="button"
					aria-label={label}
					className="rounded-sm border border-border p-0.5 hover:bg-accent"
					onClick={handleToggle}
				>
					<ColorSwatch color={{ type: "solid", color }} size={16} />
				</button>
				<Popover.Content
					side="bottom"
					sideOffset={8}
					align="end"
					anchor={buttonRef}
				>
					<div className="w-60">
						<ColorPickerThin color={color} onColorChange={onColorChange} />
					</div>
				</Popover.Content>
			</Popover.Root>
		</div>
	);
}
