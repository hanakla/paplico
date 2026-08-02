"use client";

import { X } from "lucide-react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { usePaplico, usePaplicoStore } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Top-of-canvas banner shown while a mask is being edited through
 * `paplico.maskEdit`, with the way back out.
 *
 * Without it a session has no visible end: the canvas dims and the layer
 * panel narrows, but nothing says what is being edited or how to leave.
 */
export function MaskEditBar() {
	const paplico = usePaplico();
	const snap = useSnapshot(usePaplicoStore());
	const t = useTranslation();

	const session = snap.maskEditSession;
	const ownerName = session
		? (snap.document.objects[session.ownerId]?.name ?? null)
		: null;

	const handleLeave = useEventCallback(() => {
		paplico.maskEdit.leave();
	});

	if (!session) return null;

	// Same placement as PatternEditBar: the canvas fills its container, so a
	// bar without absolute positioning flows underneath it and is clipped away
	// by the container's overflow — leaving a session with no visible exit.
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
			<div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-1.5 shadow-md backdrop-blur">
				<span className="text-xs font-medium text-foreground">
					{ownerName
						? t("maskEdit.editingNamed", { name: ownerName })
						: t("maskEdit.editing")}
				</span>
				{/* One way out, not a confirm/discard pair: the session edits the
				    mask's real objects, so everything drawn is already saved and
				    there is nothing here to approve or throw away. */}
				<Button $size="sm" $variant="ghost" onClick={handleLeave}>
					<X size={14} />
					<span className="ml-1">{t("maskEdit.leave")}</span>
				</Button>
			</div>
		</div>
	);
}
