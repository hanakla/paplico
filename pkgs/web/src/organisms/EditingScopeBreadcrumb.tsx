"use client";

import { ChevronRight } from "lucide-react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import { type AnyArtObject, TRANSIENT_LAYER_KIND } from "@/core/schema";
import { useTranslation } from "@/locales";
import { getElementTypeLabel } from "@/organisms/LayerPanel";
import { useEventCallback } from "@/utils/hooks";

export function EditingScopeBreadcrumb() {
	const paplico = usePaplico();
	const snap = useSnapshot(paplico.uiState);
	const t = useTranslation();

	const handleRootClick = useEventCallback(() => {
		paplico.selection.exitEditingScope();
	});

	const handleScopeClick = useEventCallback((elementId: string) => {
		paplico.selection.navigateToScopeLevel(elementId);
	});

	const stack = snap.editingScopeStack;
	if (stack.length === 0) return null;

	// A session's scope entry is the working layer it lends the tools, not an
	// element, so the element lookup finds nothing for it. Name it for what is
	// being edited rather than falling through to a placeholder.
	const scopeNames = stack.map((scopeId) => {
		const el = snap.document.objects[scopeId] as AnyArtObject | undefined;
		if (el) return el.name || getElementTypeLabel(el, t);

		const layer = snap.document.layers.find(
			(l: { id: string }) => l.id === scopeId,
		);
		if (layer?.transientKind === TRANSIENT_LAYER_KIND.MASK_EDIT) {
			return t("maskEdit.layerName");
		}
		if (layer?.transientKind === TRANSIENT_LAYER_KIND.PATTERN_EDIT) {
			return t("toolbar.patternName");
		}
		return layer?.name ?? "";
	});

	const items = (
		<>
			<button
				type="button"
				className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
				onClick={handleRootClick}
			>
				{t("common.canvas")}
			</button>
			{stack.map((elementId, i) => (
				<span key={elementId} className="flex items-center gap-1">
					<ChevronRight size={12} className="text-muted-foreground" />
					{i < stack.length - 1 ? (
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
							onClick={() => handleScopeClick(elementId)}
						>
							{scopeNames[i]}
						</button>
					) : (
						<span className="text-foreground font-medium">{scopeNames[i]}</span>
					)}
				</span>
			))}
		</>
	);

	return (
		<div className="relative w-52">
			{/* Invisible placeholder: reserves layout height at the panel
			    column's fixed width so the visible (overflowing) breadcrumb
			    below doesn't widen sibling panels. */}
			<div
				aria-hidden
				className="flex items-center gap-1 w-52 rounded-md px-2 py-1 text-xs opacity-0 pointer-events-none"
			>
				{items}
			</div>
			<div className="absolute top-0 left-0 flex items-center gap-1 text-nowrap bg-background/80 backdrop-blur-xl rounded-md px-2 py-1 shadow-sm text-xs pointer-events-auto">
				{items}
			</div>
		</div>
	);
}
