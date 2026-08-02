"use client";

import { useSnapshot } from "valtio";
import { Spinner } from "@/components/Spinner";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";

/**
 * Canvas-covering indicator shown while BucketFillTool computes a fill
 * region. Pointer events pass through so the user can keep placing seeds
 * or cancel while the computation runs.
 */
export function BucketFillComputingOverlay() {
	const t = useTranslation();
	const paplico = usePaplico();
	const toolSnap = useSnapshot(paplico.tools.state);

	if (!toolSnap.bucketFillComputing) return null;

	return (
		<div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/30">
			<div className="flex flex-col items-center gap-3 rounded-lg border border-border/50 bg-background/90 px-6 py-4 shadow-lg backdrop-blur-xl">
				<Spinner $size="sm" />
				<span className="text-sm font-medium text-foreground">
					{t("toolbar.bucketFillComputing")}
				</span>
			</div>
		</div>
	);
}
