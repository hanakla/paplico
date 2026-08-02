import { useEffect, useState } from "react";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { formatKeySpec } from "@/core/PaplicoShortcuts";

/**
 * Returns the formatted display string for the first keybinding registered
 * to `commandId` (e.g. "⌘C"). Re-renders when shortcuts change.
 */
export function useShortcutBinding(commandId: string): string | undefined {
	const paplico = usePaplicoMaybe();
	const [, setTick] = useState(0);

	useEffect(() => {
		if (!paplico) return;
		const handler = () => setTick((n) => n + 1);
		paplico.shortcuts.on("change", handler);
		return () => {
			paplico.shortcuts.off("change", handler);
		};
	}, [paplico]);

	if (!paplico) return undefined;
	const binding = paplico.shortcuts.getBindingsForCommand(commandId)[0];
	return binding ? formatKeySpec(binding.key) : undefined;
}
