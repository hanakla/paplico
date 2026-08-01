import { memo } from "react";
import { useSnapshot } from "valtio";
import { usePaplicoMaybe, usePaplicoStore } from "@/contexts/PaplicoContext";
import { useTargetViewport } from "@/contexts/ViewIdContext";
import { worldToScreen } from "@/core/utils/geometry/geometry";
import { useTranslation } from "@/locales";

export const MeshDeformHintOverlay = memo(function MeshDeformHintOverlay({
	canvasWidth,
	canvasHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
}) {
	const paplico = usePaplicoMaybe();
	if (!paplico) return null;

	return (
		<MeshDeformHintOverlayInner
			canvasWidth={canvasWidth}
			canvasHeight={canvasHeight}
		/>
	);
});

const MeshDeformHintOverlayInner = memo(function MeshDeformHintOverlayInner({
	canvasWidth,
	canvasHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
}) {
	const t = useTranslation();
	const store = usePaplicoStore();
	const snap = useSnapshot(store);
	const viewport = useTargetViewport();

	const session = snap.toolSession;
	if (session?.type !== "mesh-deform" || session.handleCount > 0) return null;

	const bounds = session.originalBounds;
	const worldOffsetY = 24 / viewport.zoom;
	const screen = worldToScreen(
		(bounds.minX + bounds.maxX) / 2,
		bounds.minY - worldOffsetY,
		viewport,
		canvasWidth,
		canvasHeight,
	);

	return (
		<div
			className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/60 px-3 py-1.5 text-xs text-white whitespace-nowrap"
			style={{ left: screen.x, top: screen.y }}
		>
			{t("toolbar.meshDeformHint")}
		</div>
	);
});
