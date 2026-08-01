"use client";

import { Check, X } from "lucide-react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { FakeInput } from "@/components/FakeInput";
import { usePaplico, usePaplicoStore } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Top-of-canvas banner shown while the user is editing a pattern def via
 * `paplico.patternEdit`. Provides commit / cancel buttons.
 *
 * Visibility is gated on the reactive `patternEditSession` mirror (written by
 * PaplicoPatternEdit alongside the tile-guide overlay), so the bar appears
 * whenever a session is active and the def has a tile rectangle defined.
 */
export function PatternEditBar() {
	const paplico = usePaplico();
	const store = usePaplicoStore();
	const snap = useSnapshot(store);
	const t = useTranslation();
	const session = snap.patternEditSession;
	const patternSession = paplico.patternEdit.getSession();
	const defEntry = patternSession
		? (snap.document.defs?.[patternSession.defId] ?? null)
		: null;

	const handleDone = useEventCallback(() => {
		paplico.patternEdit.commit();
	});
	const handleCancel = useEventCallback(() => {
		paplico.patternEdit.cancel();
	});
	const handleTileWidthChange = useEventCallback(
		(value: string | undefined) => {
			if (!patternSession || !defEntry?.tile) return;
			const nextWidth = Number(value);
			if (!Number.isFinite(nextWidth)) return;
			paplico.commands.updateDefMeta(patternSession.defId, {
				tile: {
					width: Math.max(0.001, nextWidth),
					height: defEntry.tile.height,
				},
			});
		},
	);
	const handleTileHeightChange = useEventCallback(
		(value: string | undefined) => {
			if (!patternSession || !defEntry?.tile) return;
			const nextHeight = Number(value);
			if (!Number.isFinite(nextHeight)) return;
			paplico.commands.updateDefMeta(patternSession.defId, {
				tile: {
					width: defEntry.tile.width,
					height: Math.max(0.001, nextHeight),
				},
			});
		},
	);
	const handleFitToBounds = useEventCallback(() => {
		if (!patternSession) return;
		const bounds = paplico.patternEdit.getSessionRootBounds();
		if (!bounds) return;
		paplico.commands.updateDefMeta(patternSession.defId, {
			tile: {
				width: Math.max(0.001, bounds.width),
				height: Math.max(0.001, bounds.height),
			},
		});
	});

	if (!session || !patternSession || !defEntry?.tile) return null;

	const tileWidthDisplay = formatTileDimension(defEntry.tile.width);
	const tileHeightDisplay = formatTileDimension(defEntry.tile.height);

	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
			<div className="pointer-events-auto flex flex-col gap-1.5 rounded-md border border-border bg-background/95 px-3 py-1.5 shadow-md backdrop-blur">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-foreground">
						{t("toolbar.patternEditBarTitle")}
					</span>
					<div className="ml-auto flex items-center gap-1">
						<Button
							$size="sm"
							$variant="ghost"
							onClick={handleCancel}
							className="text-foreground"
						>
							<X size={14} />
							<span className="ml-1">{t("toolbar.patternEditBarCancel")}</span>
						</Button>
						<Button $size="sm" $variant="default" onClick={handleDone}>
							<Check size={14} />
							<span className="ml-1">{t("toolbar.patternEditBarDone")}</span>
						</Button>
					</div>
				</div>
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-1">
						<span className="text-[10px] text-muted-foreground">
							{t("toolbar.patternEditBarTileWidth")}
						</span>
						<FakeInput
							$size="xs"
							type="number"
							step={0.001}
							min={0.001}
							value={tileWidthDisplay}
							onChange={handleTileWidthChange}
							className="w-24 text-right tabular-nums"
						/>
					</div>
					<div className="flex items-center gap-1">
						<span className="text-[10px] text-muted-foreground">
							{t("toolbar.patternEditBarTileHeight")}
						</span>
						<FakeInput
							$size="xs"
							type="number"
							step={0.001}
							min={0.001}
							value={tileHeightDisplay}
							onChange={handleTileHeightChange}
							className="w-24 text-right tabular-nums"
						/>
					</div>
					<Button
						$size="sm"
						$variant="ghost"
						onClick={handleFitToBounds}
						className="ml-auto text-foreground"
					>
						<span>{t("toolbar.patternEditBarFitToBounds")}</span>
					</Button>
				</div>
			</div>
		</div>
	);
}

function formatTileDimension(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const rounded = Math.round(value * 1000) / 1000;
	return rounded.toFixed(3);
}
