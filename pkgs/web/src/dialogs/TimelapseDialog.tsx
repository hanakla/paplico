import { Download, Pause, Play, X } from "lucide-react";
import { memo, type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Slider } from "@/components/Slider";
import { ToggleGroup } from "@/components/ToggleGroup";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import type { Paplico } from "@/core/Paplico";
import type { ChangedElements } from "@/core/renderer/types";
import { type Artboard, type Document, getArtboardBounds } from "@/core/schema";
import { TimelapseExporter } from "@/core/timelapse/TimelapseExporter";
import type { TimelapsePlayer } from "@/core/timelapse/TimelapsePlayer";
import type { TimelapsePreviewSurface } from "@/core/timelapse/TimelapsePreviewSurface";
import type { PlaybackState } from "@/core/timelapse/types";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

const SPEED_OPTIONS = [1, 2, 5, 10] as const;
const PREVIEW_WIDTH = 640;

interface TimelapseDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const TimelapseDialog = memo(function TimelapseDialog({
	open,
	onOpenChange,
}: TimelapseDialogProps) {
	const paplico = usePaplicoMaybe();
	// Held as state rather than a ref: the render surface is created from the
	// element, so its arrival has to re-run the effect.
	const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
	const t = useTranslation();

	const artboards = paplico?.uiState.document.artboards ?? [];
	const firstArtboardId = artboards[0]?.id;
	const [selectedArtboardId, setSelectedArtboardId] = useState<
		string | undefined
	>(() => firstArtboardId);

	useEffect(() => {
		if (!selectedArtboardId && firstArtboardId) {
			setSelectedArtboardId(firstArtboardId);
		}
	}, [firstArtboardId, selectedArtboardId]);

	const selectedArtboard = artboards.find((ab) => ab.id === selectedArtboardId);

	const handleArtboardClick = useEventCallback((ab: Artboard) => {
		setSelectedArtboardId(ab.id);
	});

	const artboard = selectedArtboard;

	const {
		playerRef,
		surfaceRef,
		state,
		handlePlayPause,
		handleSeek,
		handleSpeedChange,
	} = useTimelapsePlayer(paplico, canvasEl, artboard, open);

	const { exporting, exportProgress, handleExportMP4 } = useTimelapseExport(
		paplico,
		playerRef,
		surfaceRef,
		artboard,
		state.speed,
	);

	const canvasAspect = artboard
		? (() => {
				const bounds = getArtboardBounds(artboard);
				return bounds.height / bounds.width;
			})()
		: 9 / 16;
	const previewHeight = Math.round(PREVIEW_WIDTH * canvasAspect);

	const hasData = state.totalEvents > 0;
	const canvasOpacity = state.introPhase === "fadeOut" ? 0 : 1;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[700px] max-h-[90vh] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("timelapseDialog.timelapse")}
					</Dialog.Title>
					<Dialog.Close>
						<button
							type="button"
							className={twm(
								"p-1 rounded hover:bg-foreground/10 transition-colors",
								"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
							)}
						>
							<X size={16} />
						</button>
					</Dialog.Close>
				</div>

				{/* Artboard selector */}
				{artboards.length > 0 && (
					<div className="px-4 pt-4">
						<h1 className="text-sm font-medium text-muted-foreground mb-2 block">
							{t("timelapseDialog.artboard")}
						</h1>
						<div className="flex gap-2 overflow-x-auto pb-2">
							{artboards.map((ab) => {
								const bounds = getArtboardBounds(ab);
								const aspectRatio = bounds.width / bounds.height;
								const isSelected = ab.id === selectedArtboardId;
								return (
									<ArtboardThumbnail
										key={ab.id}
										artboard={ab}
										isSelected={isSelected}
										aspectRatio={aspectRatio}
										onClick={() => handleArtboardClick(ab)}
										paplico={paplico}
									/>
								);
							})}
						</div>
					</div>
				)}

				{/* Preview */}
				<div className="px-4 pt-4">
					<div
						className="relative bg-black/5 rounded-lg overflow-hidden"
						style={{ height: previewHeight, maxHeight: "50vh" }}
					>
						{/* The canvas stays mounted so its render surface can be created
						    before the player reports how many frames there are. */}
						<canvas
							ref={setCanvasEl}
							className={twm(
								"w-full h-full object-contain transition-opacity duration-300",
								!hasData && "invisible",
							)}
							style={{ opacity: canvasOpacity }}
						/>
						{!hasData && (
							<div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
								{t("timelapseDialog.noTimelapseData")}
							</div>
						)}
					</div>
				</div>

				{/* Controls */}
				{hasData && (
					<div className="px-4 py-3 space-y-3">
						{/* Seek bar */}
						<Slider
							min={0}
							max={state.totalEvents - 1}
							step={1}
							value={state.currentIndex}
							onValueChange={(v) =>
								handleSeek(typeof v === "number" ? v : v[0])
							}
							disabled={exporting || state.isPreparing}
						/>

						{/* Play controls */}
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Button
									$variant="ghost"
									$size="sm"
									onClick={handlePlayPause}
									disabled={exporting || state.isPreparing}
								>
									{state.isPlaying ? <Pause size={16} /> : <Play size={16} />}
								</Button>

								{/* Speed buttons */}
								<ToggleGroup.Root
									value={[String(state.speed)]}
									onValueChange={(value) => {
										if (value.length > 0) {
											handleSpeedChange(Number(value[0]));
										}
									}}
									disabled={exporting || state.isPreparing}
								>
									{SPEED_OPTIONS.map((s) => (
										<ToggleGroup.Item
											key={s}
											value={String(s)}
											className="text-xs font-medium"
										>
											{s}x
										</ToggleGroup.Item>
									))}
								</ToggleGroup.Root>
							</div>

							<span className="text-xs text-muted-foreground tabular-nums">
								{state.currentIndex + 1} / {state.totalEvents}
							</span>
						</div>

						{/* Export */}
						{TimelapseExporter.isSupported() && (
							<div className="flex items-center justify-between pt-2 border-t border-border/30">
								{exporting ? (
									<div className="flex items-center gap-2 flex-1">
										<div className="flex-1 h-1.5 bg-foreground/10 rounded-full overflow-hidden">
											<div
												className="h-full bg-primary rounded-full transition-[width] duration-200"
												style={{
													width: `${exportProgress * 100}%`,
												}}
											/>
										</div>
										<span className="text-xs text-muted-foreground tabular-nums">
											{Math.round(exportProgress * 100)}%
										</span>
									</div>
								) : (
									<span className="text-xs text-muted-foreground">
										{artboard
											? t("timelapseDialog.exportAsMP4")
											: t("timelapseDialog.artboardRequired")}
									</span>
								)}
								<Tooltip
									content={t("timelapseDialog.artboardRequiredTooltip")}
									side="top"
									disabled={!!artboard}
								>
									<div>
										{" "}
										<Button
											$variant="default"
											$size="sm"
											onClick={artboard ? handleExportMP4 : undefined}
											disabled={exporting || state.isPreparing || !artboard}
										>
											<Download size={14} />
											{t("timelapseDialog.saveVideo")}
										</Button>
									</div>
								</Tooltip>
							</div>
						)}
					</div>
				)}
			</Dialog.Content>
		</Dialog.Root>
	);
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const INITIAL_STATE: PlaybackState = {
	isPlaying: false,
	isPreparing: false,
	currentIndex: -1,
	totalEvents: 0,
	speed: 1,
	pathAnimProgress: null,
	introPhase: null,
};

/**
 * Owns the dedicated WebGPU surface playback draws through. Frames go straight
 * to the canvas, so nothing is read back from the GPU per frame.
 */
function useTimelapseSurface(
	paplico: Paplico | null,
	canvas: HTMLCanvasElement | null,
	open: boolean,
) {
	const surfaceRef = useRef<TimelapsePreviewSurface | null>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!open || !canvas || !paplico) return;

		let disposed = false;
		void paplico.createTimelapsePreviewSurface(canvas).then((surface) => {
			if (disposed) {
				surface.dispose();
				return;
			}
			surfaceRef.current = surface;
			setReady(true);
		});

		return () => {
			disposed = true;
			setReady(false);
			surfaceRef.current?.dispose();
			surfaceRef.current = null;
		};
	}, [open, paplico, canvas]);

	return { surfaceRef, ready };
}

/** Manages TimelapsePlayer lifecycle, playback state, and control handlers. */
function useTimelapsePlayer(
	paplico: Paplico | null,
	canvas: HTMLCanvasElement | null,
	artboard: Artboard | undefined,
	open: boolean,
) {
	const playerRef = useRef<TimelapsePlayer | null>(null);
	const [state, setState] = useState<PlaybackState>(INITIAL_STATE);
	const { surfaceRef, ready } = useTimelapseSurface(paplico, canvas, open);

	const renderFrame = useEventCallback(
		(document: Document, changes: ChangedElements | undefined) => {
			if (!artboard) return;
			surfaceRef.current?.render(document, artboard, changes);
		},
	);

	useEffect(() => {
		if (!open || !ready) {
			playerRef.current?.dispose();
			playerRef.current = null;
			return;
		}

		if (!paplico?.createTimelapsePlayer) return;
		const player = paplico?.createTimelapsePlayer(
			{
				onFrame: renderFrame,
				onStateChange: setState,
			},
			artboard ?? null,
		);
		if (!player) {
			playerRef.current = null;
			setState(INITIAL_STATE);
			return;
		}

		playerRef.current = player;
		// seekTo emits the real state, including whether the player is still
		// rebuilding a missing index. Seeding INITIAL_STATE here would clobber it.
		player.seekTo(0);

		return () => {
			player.dispose();
			playerRef.current = null;
		};
	}, [open, ready, paplico?.createTimelapsePlayer, artboard, renderFrame]);

	const handlePlayPause = useEventCallback(() => {
		const player = playerRef.current;
		if (!player) return;
		if (state.isPlaying) {
			player.pause();
		} else {
			player.play();
		}
	});

	const handleSeek = useEventCallback((value: number) => {
		playerRef.current?.seekTo(value);
	});

	const handleSpeedChange = useEventCallback((speed: number) => {
		playerRef.current?.setSpeed(speed);
	});

	return {
		playerRef,
		surfaceRef,
		state,
		handlePlayPause,
		handleSeek,
		handleSpeedChange,
	};
}

/** Manages MP4 export state and handler. */
function useTimelapseExport(
	paplico: Paplico | null,
	playerRef: RefObject<TimelapsePlayer | null>,
	surfaceRef: RefObject<TimelapsePreviewSurface | null>,
	artboard: Artboard | undefined,
	speed: number,
) {
	const [exporting, setExporting] = useState(false);
	const [exportProgress, setExportProgress] = useState(0);

	const handleExportMP4 = useEventCallback(async () => {
		const player = playerRef.current;
		const surface = surfaceRef.current;
		if (!player || !surface || !artboard || !paplico) return;

		player.pause();
		setExporting(true);
		setExportProgress(0);

		try {
			const exporter = paplico.createTimelapseExporter(surface, player);
			const blob = await exporter.exportMP4({
				artboard,
				fps: 30,
				speed,
				onProgress: setExportProgress,
			});

			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `timelapse-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error("MP4 export failed:", error);
		} finally {
			setExporting(false);
		}
	});

	return { exporting, exportProgress, handleExportMP4 };
}

// ---------------------------------------------------------------------------
// Artboard Thumbnail Component
// ---------------------------------------------------------------------------

interface ArtboardThumbnailProps {
	artboard: Artboard;
	isSelected: boolean;
	aspectRatio: number;
	onClick: () => void;
	paplico: Paplico | null;
}

const ArtboardThumbnail = memo(function ArtboardThumbnail({
	artboard,
	isSelected,
	onClick,
	paplico,
}: ArtboardThumbnailProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !paplico) return;

		paplico
			.renderArtboardToImageData(artboard, paplico.uiState.document)
			.then((imageData) => {
				if (!imageData) return;
				const ctx = canvas.getContext("2d");
				if (ctx) {
					canvas.width = imageData.width;
					canvas.height = imageData.height;
					ctx.putImageData(imageData, 0, 0);
				}
			});
	}, [artboard, paplico]);

	return (
		<button
			type="button"
			onClick={onClick}
			className={twm(
				"shrink-0 rounded-lg border-2 transition-all overflow-hidden",
				"hover:border-accent/50",
				"focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
				isSelected ? "border-accent shadow-md" : "border-border/30",
			)}
			style={{ height: 80 }}
		>
			<canvas ref={canvasRef} className="h-full object-contain bg-muted/30" />
		</button>
	);
});
