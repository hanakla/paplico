import { debounce } from "es-toolkit";
import {
	ArrowUpDown,
	Box,
	Circle,
	Eraser,
	Frame,
	Grid3x3,
	GripVertical,
	Italic,
	Menu as MenuIcon,
	MousePointer,
	PaintBucket,
	Pen,
	PenTool,
	Pipette,
	Redo,
	Route,
	Scaling,
	Slash,
	Spline,
	Square,
	Star,
	Type,
	Undo,
	X as XIcon,
} from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { FillStrokeSwatchPicker } from "@/components/FillStrokeSwatchPicker";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Popover } from "@/components/Popover";
import { Portal } from "@/components/Portal";
import { Resizable } from "@/components/Resizable";
import { Separator } from "@/components/Separator";
import { Slider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { ShapeType } from "@/core";
import { createDefaultColor } from "@/core/document/factory";
import type { Color } from "@/core/schema";
import { BucketFillTool } from "@/core/tools/BucketFillTool";
import { useActiveColors } from "@/hooks/useActiveColors";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useTranslation } from "@/locales";
import {
	BRUSH_DESIGNER_PANEL_MAX_WIDTH,
	BRUSH_DESIGNER_PANEL_MIN_WIDTH,
	setBrushDesignerPanelOpen,
	setBrushDesignerPanelWidth,
	setBrushPanelOpen,
	toggleBrushPanel,
	uiState,
	useUIState,
} from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { MobileMenuSheet } from "../MobileMenuSheet";
import { BrushDesignerPanel, BrushSettingsPanel } from "./BrushTools";

export function Toolbar({
	className,
	side = "left",
	mobileMenuProps,
	adjacentPanel,
}: {
	className?: string;
	side?: "left" | "right";
	mobileMenuProps?: MobileMenuSheet.Props;
	/** Panel docked next to the toolbar; the toolbar owns its frame and resizing. */
	adjacentPanel?: {
		desktop: ReactNode;
		mobile?: ReactNode;
		width: number;
		minWidth: number;
		maxWidth: number;
		onWidthChange: (width: number) => void;
	};
}) {
	const t = useTranslation();
	const layoutMode = useLayoutMode();
	const [menuSheetOpen, setMenuSheetOpen] = useState(false);
	const paplico = usePaplico();
	const tools = paplico.tools;
	const commands = paplico.commands;
	const store = paplico.uiState;
	const isReadonly = paplico.isReadonly;

	const snap = useSnapshot(tools.state);
	const docSnap = useSnapshot(store);
	const uiSnap = useUIState();

	// Everything anchored to the toolbar opens toward the canvas.
	const outwardSide = side === "left" ? "right" : "left";

	// Toggle brush panel with B key when pen tool is active or brush panel is open
	// biome-ignore lint/correctness/useExhaustiveDependencies: stable ref via useEventCallback
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.code !== "KeyB") return;
			// If brush panel is open, always close it (even if focus is inside the panel's input, e.g. size slider)
			if (uiState.brushPanelOpen) {
				e.preventDefault();
				e.stopPropagation();
				setBrushPanelOpen(false);
				return;
			}
			// Toggle open when pen tool is active and focus is not in a text input
			if (
				tools.state.currentTool === "pen" &&
				!(e.target instanceof HTMLInputElement) &&
				!(e.target instanceof HTMLTextAreaElement)
			) {
				e.preventDefault();
				e.stopPropagation();
				toggleBrushPanel();
			}
		};
		window.addEventListener("keydown", handler, { capture: true });

		return () =>
			window.removeEventListener("keydown", handler, { capture: true });
	}, []);

	const { currentFill } = useActiveColors();

	// Pen tool button behavior:
	// - Short press + other tool active: switch to pen tool
	// - Short press + pen tool active: toggle brush panel
	// - Long press + other tool active: switch to pen tool + open brush panel
	// - Long press + pen tool active: open brush panel
	const penButtonRef = useRef<HTMLButtonElement>(null);
	const brushPanelRef = useRef<HTMLDivElement>(null);
	const penLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const penLongPressed = useRef(false);
	const brushDesignerPanelOpen = uiSnap.brushDesignerPanelOpen;
	const designerInitialPresetUidRef = useRef<string | null>(null);

	const handleOpenMenuSheet = useEventCallback(() => {
		setMenuSheetOpen(true);
	});
	const handleCloseMenuSheet = useEventCallback(() => {
		setMenuSheetOpen(false);
	});

	const openBrushDesignerPanel = useEventCallback(() => {
		designerInitialPresetUidRef.current = uiState.selectedBrushPresetUid;
		setBrushPanelOpen(false);
		setBrushDesignerPanelOpen(true);
	});

	const closeBrushDesignerPanel = useEventCallback(() => {
		setBrushDesignerPanelOpen(false);
	});

	const handleBrushPresetSaved = useEventCallback(() => {
		setBrushPanelOpen(true);
	});

	const handlePenToolPointerDown = useEventCallback(() => {
		penLongPressed.current = false;
		penLongPressTimer.current = setTimeout(() => {
			penLongPressed.current = true;
			penLongPressTimer.current = null;
			// Long press: activate pen tool + open brush panel
			tools.setCurrentTool("pen");
			setBrushDesignerPanelOpen(false);
			setBrushPanelOpen(true);
		}, 300);
	});

	const handlePenToolPointerUp = useEventCallback(() => {
		if (penLongPressed.current) return;

		if (penLongPressTimer.current !== null) {
			clearTimeout(penLongPressTimer.current);
			penLongPressTimer.current = null;
		}

		// Short press
		if (snap.currentTool === "pen") {
			if (brushDesignerPanelOpen) {
				setBrushDesignerPanelOpen(false);
				setBrushPanelOpen(true);
				return;
			}

			setBrushPanelOpen(!uiSnap.brushPanelOpen);
		} else {
			tools.setCurrentTool("pen");
			setBrushDesignerPanelOpen(false);
		}
	});

	// Close brush panel on outside click
	useEffect(() => {
		if (!uiSnap.brushPanelOpen) return;

		const handler = (e: PointerEvent) => {
			const target = e.target as Node;
			if (penButtonRef.current?.contains(target)) return;
			if (brushPanelRef.current?.contains(target)) return;
			setBrushPanelOpen(false);
		};

		document.addEventListener("pointerdown", handler);
		return () => document.removeEventListener("pointerdown", handler);
	}, [uiSnap.brushPanelOpen]);

	// Shape tool button behavior:
	// - Short press + other tool active: switch to shape tool
	// - Short press + shape tool active: toggle shape panel
	// - Long press + other tool active: switch to shape tool + open shape panel
	// - Long press + shape tool active: open shape panel
	const shapeButtonRef = useRef<HTMLButtonElement>(null);
	const shapePanelRef = useRef<HTMLDivElement>(null);
	const shapeLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const shapeLongPressed = useRef(false);
	const [shapePanelOpen, setShapePanelOpen] = useState(false);

	const handleShapeToolPointerDown = useEventCallback(() => {
		shapeLongPressed.current = false;
		shapeLongPressTimer.current = setTimeout(() => {
			shapeLongPressed.current = true;
			shapeLongPressTimer.current = null;
			tools.setCurrentTool("shape");
			setShapePanelOpen(true);
		}, 300);
	});

	const handleShapeToolPointerUp = useEventCallback(() => {
		if (shapeLongPressed.current) return;

		if (shapeLongPressTimer.current !== null) {
			clearTimeout(shapeLongPressTimer.current);
			shapeLongPressTimer.current = null;
		}

		if (snap.currentTool === "shape") {
			setShapePanelOpen(!shapePanelOpen);
		} else {
			tools.setCurrentTool("shape");
		}
	});

	// Close shape panel on outside click
	useEffect(() => {
		if (!shapePanelOpen) return;

		const handler = (e: PointerEvent) => {
			const target = e.target as Node;
			if (shapeButtonRef.current?.contains(target)) return;
			if (shapePanelRef.current?.contains(target)) return;
			setShapePanelOpen(false);
		};

		document.addEventListener("pointerdown", handler);
		return () => document.removeEventListener("pointerdown", handler);
	}, [shapePanelOpen]);

	// Transform group (mesh-deform + skew), mirrors the shape group. Unlike
	// shape (one id + sub-type), these are two sibling ToolTypes, so the flyout
	// switches currentTool and the group remembers the last-used member.
	const transformButtonRef = useRef<HTMLButtonElement>(null);
	const transformPanelRef = useRef<HTMLDivElement>(null);
	const transformLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const transformLongPressed = useRef(false);
	const [transformPanelOpen, setTransformPanelOpen] = useState(false);
	const [lastTransformTool, setLastTransformTool] = useState<
		"free-transform" | "mesh-deform" | "skew"
	>("free-transform");

	const isTransformTool =
		snap.currentTool === "free-transform" ||
		snap.currentTool === "mesh-deform" ||
		snap.currentTool === "skew";

	// Track group membership changed outside the flyout too (keyboard cycle),
	// so the group button's icon and re-entry target follow the active tool.
	useEffect(() => {
		if (isTransformTool) {
			setLastTransformTool(
				snap.currentTool as "free-transform" | "mesh-deform" | "skew",
			);
		}
	}, [isTransformTool, snap.currentTool]);

	const handleTransformToolPointerDown = useEventCallback(() => {
		transformLongPressed.current = false;
		transformLongPressTimer.current = setTimeout(() => {
			transformLongPressed.current = true;
			transformLongPressTimer.current = null;
			tools.setCurrentTool(lastTransformTool);
			setTransformPanelOpen(true);
		}, 300);
	});

	const handleTransformToolPointerUp = useEventCallback(() => {
		if (transformLongPressed.current) return;
		if (transformLongPressTimer.current !== null) {
			clearTimeout(transformLongPressTimer.current);
			transformLongPressTimer.current = null;
		}
		if (isTransformTool) {
			setTransformPanelOpen(!transformPanelOpen);
		} else {
			tools.setCurrentTool(lastTransformTool);
		}
	});

	const handleTransformToolSelect = useEventCallback(
		(type: "free-transform" | "mesh-deform" | "skew") => {
			setLastTransformTool(type);
			tools.setCurrentTool(type);
			setTransformPanelOpen(false);
		},
	);

	useEffect(() => {
		if (!transformPanelOpen) return;

		const handler = (e: PointerEvent) => {
			const target = e.target as Node;
			if (transformButtonRef.current?.contains(target)) return;
			if (transformPanelRef.current?.contains(target)) return;
			setTransformPanelOpen(false);
		};

		document.addEventListener("pointerdown", handler);
		return () => document.removeEventListener("pointerdown", handler);
	}, [transformPanelOpen]);

	const handleReference3DToolClick = useEventCallback(() => {
		tools.setCurrentTool("reference3d");
	});

	return (
		<div className="relative h-full isolate overflow-visible">
			<div
				className={twm(
					"relative min-w-12 w-fit h-full bg-background/80 backdrop-liquid",
					"flex flex-col items-center gap-1 overflow-y-auto z-[10]",
					"pt-notch-top pb-notch-bottom transition-[padding] duration-100",
					side === "left" ? "pl-notch-left" : "pr-notch-right",
					className,
				)}
			>
				{isReadonly && (
					<span className="text-[9px] font-semibold text-muted-foreground px-1 pb-1">
						Read-only
					</span>
				)}
				{mobileMenuProps && layoutMode != null && layoutMode !== "desktop" && (
					<>
						<IconButton
							$size="md"
							$variant="ghost"
							className="flex-none"
							onClick={handleOpenMenuSheet}
						>
							<MenuIcon size={16} />
						</IconButton>
						<Separator orientation="horizontal" />
					</>
				)}
				<div
					className={twm(
						"flex flex-col items-center gap-1",
						isReadonly && "opacity-40 pointer-events-none",
					)}
				>
					<Popover.Root open={uiSnap.brushPanelOpen}>
						<Tooltip content={t("toolbar.penTool")} side={outwardSide}>
							<IconButton
								ref={penButtonRef}
								$size="md"
								$variant="ghost"
								$pressed={snap.currentTool === "pen"}
								className="flex-none"
								onPointerDown={handlePenToolPointerDown}
								onPointerUp={handlePenToolPointerUp}
							>
								<Pen size={16} />
							</IconButton>
						</Tooltip>
						<Popover.Content
							side={outwardSide}
							sideOffset={8}
							align="start"
							anchor={penButtonRef}
						>
							<div ref={brushPanelRef}>
								<BrushSettingsPanel onOpenDesigner={openBrushDesignerPanel} />
							</div>
						</Popover.Content>
					</Popover.Root>

					<Tooltip content={t("toolbar.eraserTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "eraser"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("eraser")}
						>
							<Eraser size={16} />
						</IconButton>
					</Tooltip>

					<Tooltip content={t("toolbar.eyedropperTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "eyedropper"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("eyedropper")}
						>
							<Pipette size={16} />
						</IconButton>
					</Tooltip>

					<Tooltip content={t("toolbar.selectTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "select"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("select")}
						>
							<MousePointer size={16} />
						</IconButton>
					</Tooltip>

					<Tooltip content={t("toolbar.pathTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "path"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("path")}
						>
							<PenTool size={16} />
						</IconButton>
					</Tooltip>

					<Popover.Root open={shapePanelOpen}>
						<Tooltip content={t("toolbar.shapeTool")} side={outwardSide}>
							<IconButton
								ref={shapeButtonRef}
								$size="md"
								$variant="ghost"
								$pressed={snap.currentTool === "shape"}
								className="flex-none"
								onPointerDown={handleShapeToolPointerDown}
								onPointerUp={handleShapeToolPointerUp}
							>
								<Square size={16} />
							</IconButton>
						</Tooltip>
						<Popover.Content
							className="p-1"
							side={outwardSide}
							sideOffset={8}
							align="center"
							anchor={shapeButtonRef}
						>
							<div ref={shapePanelRef}>
								<ShapeSettingsPanel tooltipSide={outwardSide} />
							</div>
						</Popover.Content>
					</Popover.Root>

					<Tooltip content={t("toolbar.textTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "text"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("text")}
						>
							<Type size={16} />
						</IconButton>
					</Tooltip>

					<Separator orientation="horizontal" />

					<Popover.Root open={snap.currentTool === "bucket-fill"}>
						<Tooltip content={t("toolbar.bucketFillTool")} side={outwardSide}>
							<Popover.Trigger>
								<IconButton
									$size="md"
									$variant="ghost"
									$pressed={snap.currentTool === "bucket-fill"}
									onClick={() => {
										if (currentFill) {
											tools.setFillColor(currentFill);
										}
										tools.setCurrentTool("bucket-fill");
									}}
								>
									<PaintBucket size={16} />
								</IconButton>
							</Popover.Trigger>
						</Tooltip>
						<Popover.Content side={outwardSide} sideOffset={8} align="center">
							<BucketFillPanel />
						</Popover.Content>
					</Popover.Root>

					<Tooltip content={t("toolbar.pathEditTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "path-edit"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("path-edit")}
						>
							<Route size={16} />
						</IconButton>
					</Tooltip>

					<Popover.Root open={transformPanelOpen}>
						<Tooltip content={t("toolbar.transformTool")} side={outwardSide}>
							<IconButton
								ref={transformButtonRef}
								$size="md"
								$variant="ghost"
								$pressed={isTransformTool}
								className="flex-none"
								onPointerDown={handleTransformToolPointerDown}
								onPointerUp={handleTransformToolPointerUp}
							>
								{lastTransformTool === "skew" ? (
									<Italic size={16} />
								) : lastTransformTool === "mesh-deform" ? (
									<Grid3x3 size={16} />
								) : (
									<Scaling size={16} />
								)}
							</IconButton>
						</Tooltip>
						<Popover.Content
							className="p-1"
							side={outwardSide}
							sideOffset={8}
							align="center"
							anchor={transformButtonRef}
						>
							<div ref={transformPanelRef}>
								<TransformSettingsPanel
									tooltipSide={outwardSide}
									onSelect={handleTransformToolSelect}
								/>
							</div>
						</Popover.Content>
					</Popover.Root>

					<Tooltip content={t("toolbar.gradientTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "gradient"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("gradient")}
						>
							<div className="size-4 border rounded-sm border-foreground bg-[linear-gradient(to_right,var(--background),var(--foreground))]" />
						</IconButton>
					</Tooltip>

					<Tooltip
						content={t("toolbar.strokeWidthEditTool")}
						side={outwardSide}
					>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "stroke-width-edit"}
							className="flex-none"
							onClick={() => tools.setCurrentTool("stroke-width-edit")}
						>
							<GripVertical size={16} />
						</IconButton>
					</Tooltip>

					<Tooltip content={t("toolbar.reference3dTool")} side={outwardSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === "reference3d"}
							className="flex-none"
							onClick={handleReference3DToolClick}
						>
							<Box size={16} />
						</IconButton>
					</Tooltip>

					<Separator orientation="horizontal" />

					<Popover.Root open={snap.currentTool === "artboard"}>
						<Tooltip content={t("toolbar.artboardTool")} side={outwardSide}>
							<Popover.Trigger>
								<IconButton
									$size="md"
									$variant="ghost"
									$pressed={snap.currentTool === "artboard"}
									onClick={() => tools.setCurrentTool("artboard")}
								>
									<Frame size={16} />
								</IconButton>
							</Popover.Trigger>
						</Tooltip>
						<Popover.Content side={outwardSide} sideOffset={8} align="center">
							<ArtboardInfoPanel />
						</Popover.Content>
					</Popover.Root>

					<Separator orientation="horizontal" />

					{/* Undo/Redo */}
					<div className="flex flex-col gap-2">
						<Tooltip content={t("toolbar.undoTooltip")} side={outwardSide}>
							<IconButton
								$size="md"
								$variant="ghost"
								className="flex-none"
								onClick={() => commands.undo()}
								disabled={!docSnap.canUndo}
							>
								<Undo size={16} />
							</IconButton>
						</Tooltip>

						<Tooltip content={t("toolbar.redoTooltip")} side={outwardSide}>
							<IconButton
								$size="md"
								$variant="ghost"
								className="flex-none"
								onClick={() => commands.redo()}
								disabled={!docSnap.canRedo}
							>
								<Redo size={16} />
							</IconButton>
						</Tooltip>
					</div>

					<Separator orientation="horizontal" />

					<div className="relative py-2">
						<FillStrokeSwatchPicker className="w-10 h-10 mx-auto" />

						{/* Swap fill ↔ stroke colors */}
						<Tooltip content={t("toolbar.swapColors")} side={outwardSide}>
							<button
								type="button"
								className="mx-auto mt-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
								onClick={() => {
									tools.swapColors();
									if (store.selectedElementIds.length > 0) {
										commands.swapSelectedElementsColors();
									}
								}}
							>
								<ArrowUpDown size={12} />
							</button>
						</Tooltip>
					</div>
				</div>
			</div>

			{brushDesignerPanelOpen ? (
				<ToolbarAdjacentPanel
					// Remounts on switch so the frame picks up this panel's own width.
					key="brush-designer"
					side={side}
					width={uiSnap.brushDesignerPanelWidth}
					minWidth={BRUSH_DESIGNER_PANEL_MIN_WIDTH}
					maxWidth={BRUSH_DESIGNER_PANEL_MAX_WIDTH}
					onWidthChange={setBrushDesignerPanelWidth}
					mobile={
						<BrushDesignerPanel
							variant="mobile"
							onClose={closeBrushDesignerPanel}
							onSaved={handleBrushPresetSaved}
							initialPresetUid={designerInitialPresetUidRef.current}
						/>
					}
					desktop={
						<BrushDesignerPanel
							side={side}
							onClose={closeBrushDesignerPanel}
							onSaved={handleBrushPresetSaved}
							initialPresetUid={designerInitialPresetUidRef.current}
						/>
					}
				/>
			) : adjacentPanel ? (
				<ToolbarAdjacentPanel
					key="adjacent"
					side={side}
					width={adjacentPanel.width}
					minWidth={adjacentPanel.minWidth}
					maxWidth={adjacentPanel.maxWidth}
					onWidthChange={adjacentPanel.onWidthChange}
					mobile={adjacentPanel.mobile ?? adjacentPanel.desktop}
					desktop={adjacentPanel.desktop}
				/>
			) : null}

			{mobileMenuProps && menuSheetOpen && (
				<Portal>
					<div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col pointer-events-auto pl-safe-left pr-safe-right">
						<div className="flex items-center justify-between px-4 pt-safe-top pb-3 border-b border-border min-h-12">
							<span className="text-sm font-semibold">Menu</span>
							<IconButton
								$size="md"
								$variant="ghost"
								onClick={handleCloseMenuSheet}
							>
								<XIcon size={16} />
							</IconButton>
						</div>
						<div className="flex-1 overflow-y-auto py-2 pb-safe-bottom">
							<MobileMenuSheet
								{...mobileMenuProps}
								onClose={handleCloseMenuSheet}
							/>
						</div>
					</div>
				</Portal>
			)}
		</div>
	);
}

/**
 * Frame for the panel docked next to the toolbar. On desktop it expands from the
 * toolbar edge and can be resized by its inner edge; on mobile it takes over the
 * screen, staying clear of the notch and the home indicator.
 */
function ToolbarAdjacentPanel({
	side,
	width,
	minWidth,
	maxWidth,
	onWidthChange,
	mobile,
	desktop,
}: {
	side: "left" | "right";
	width: number;
	minWidth: number;
	maxWidth: number;
	onWidthChange: (width: number) => void;
	mobile: ReactNode;
	desktop: ReactNode;
}) {
	const layoutMode = useLayoutMode();

	const handlePointerDown = useEventCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.stopPropagation();
		},
	);

	if (layoutMode != null && layoutMode !== "desktop") {
		return (
			<Portal>
				{/* The background covers the whole screen; the panel inside it does not. */}
				<div
					className="fixed inset-0 z-50 bg-background pointer-events-auto flex flex-col pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
					onPointerDown={handlePointerDown}
				>
					{mobile}
				</div>
			</Portal>
		);
	}

	return (
		<div
			className={twm(
				"absolute inset-y-0 z-0 h-full pointer-events-auto",
				side === "left"
					? "left-full animate-panel-expand"
					: "right-full animate-panel-expand-rtl",
			)}
			onPointerDown={handlePointerDown}
		>
			<Resizable
				dir={side === "left" ? "right" : "left"}
				defaultSize={width}
				minSize={minWidth}
				maxSize={maxWidth}
				onSizeChange={onWidthChange}
				className="h-full max-w-[calc(100vw-4rem)]"
			>
				{desktop}
			</Resizable>
		</div>
	);
}

function ArtboardInfoPanel() {
	const t = useTranslation();
	const paplico = usePaplico();
	const commands = paplico.commands;
	const store = paplico.uiState;

	const docSnap = useSnapshot(store);
	const selectedArtboard = docSnap.document.artboards.find(
		(a) => a.id === docSnap.selectedArtboardId,
	);

	const [localValues, setLocalValues] = useState({
		name: "",
		width: "",
		height: "",
		x: "",
		y: "",
	});

	// Sync local values when selection changes
	useEffect(() => {
		if (selectedArtboard) {
			setLocalValues({
				name: selectedArtboard.name,
				width: selectedArtboard.width.toFixed(2),
				height: selectedArtboard.height.toFixed(2),
				x: selectedArtboard.x.toFixed(2),
				y: selectedArtboard.y.toFixed(2),
			});
		}
	}, [selectedArtboard]);

	const handleNameChange = useEventCallback((value: string) => {
		setLocalValues((prev) => ({ ...prev, name: value }));
	});

	const handleNameBlur = useEventCallback(() => {
		if (docSnap.selectedArtboardId && localValues.name.trim()) {
			commands.updateArtboard(docSnap.selectedArtboardId, {
				name: localValues.name,
			});
		}
	});

	const handleDimensionChange = useEventCallback(
		(field: "width" | "height" | "x" | "y", value: string) => {
			setLocalValues((prev) => ({ ...prev, [field]: value }));
		},
	);

	const handleDimensionBlur = useEventCallback(
		(field: "width" | "height" | "x" | "y") => {
			if (!docSnap.selectedArtboardId) return;

			const numValue = Number.parseFloat(localValues[field]);
			if (Number.isNaN(numValue)) {
				// Reset to original value
				if (selectedArtboard) {
					setLocalValues((prev) => ({
						...prev,
						[field]: selectedArtboard[field].toFixed(2),
					}));
				}
				return;
			}

			// Validate minimum size for width/height
			if ((field === "width" || field === "height") && numValue < 10) {
				setLocalValues((prev) => ({ ...prev, [field]: (10).toFixed(2) }));
				commands.updateArtboard(docSnap.selectedArtboardId, { [field]: 10 });
				return;
			}

			commands.updateArtboard(docSnap.selectedArtboardId, {
				[field]: numValue,
			});
		},
	);

	const handleKeyDown = useEventCallback(
		(
			e: React.KeyboardEvent<HTMLInputElement>,
			_field: "name" | "width" | "height" | "x" | "y",
		) => {
			if (e.key === "Enter") {
				e.currentTarget.blur();
			}
		},
	);

	const dimensionInputId = useId();

	if (!selectedArtboard) {
		return (
			<div className="w-44 p-2">
				<p className="text-[10px] text-muted-foreground text-center leading-tight">
					{t("toolbar.artboardSelectOrCreate")}
				</p>
			</div>
		);
	}

	return (
		<div className="w-44 flex flex-col gap-2">
			<Input
				$size="xs"
				value={localValues.name}
				onChange={(e) => handleNameChange(e.target.value)}
				onBlur={handleNameBlur}
				onKeyDown={(e) => handleKeyDown(e, "name")}
			/>

			<div className="grid grid-cols-2 gap-1.5">
				<div className="flex items-center gap-1">
					<label
						htmlFor={`${dimensionInputId}-width`}
						className="text-[10px] text-muted-foreground w-3"
					>
						W
					</label>
					<Input
						id={`${dimensionInputId}-width`}
						type="number"
						$size="xs"
						value={localValues.width}
						onChange={(e) => handleDimensionChange("width", e.target.value)}
						onBlur={() => handleDimensionBlur("width")}
						onKeyDown={(e) => handleKeyDown(e, "width")}
						className="font-mono tabular-nums"
					/>
				</div>
				<div className="flex items-center gap-1">
					<label
						htmlFor={`${dimensionInputId}-height`}
						className="text-[10px] text-muted-foreground w-3"
					>
						H
					</label>
					<Input
						id={`${dimensionInputId}-height`}
						type="number"
						$size="xs"
						value={localValues.height}
						onChange={(e) => handleDimensionChange("height", e.target.value)}
						onBlur={() => handleDimensionBlur("height")}
						onKeyDown={(e) => handleKeyDown(e, "height")}
						className="font-mono tabular-nums"
					/>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-1.5">
				<div className="flex items-center gap-1">
					<label
						htmlFor={`${dimensionInputId}-x`}
						className="text-[10px] text-muted-foreground w-3"
					>
						X
					</label>
					<Input
						id={`${dimensionInputId}-x`}
						type="number"
						$size="xs"
						value={localValues.x}
						onChange={(e) => handleDimensionChange("x", e.target.value)}
						onBlur={() => handleDimensionBlur("x")}
						onKeyDown={(e) => handleKeyDown(e, "x")}
						className="font-mono tabular-nums"
					/>
				</div>
				<div className="flex items-center gap-1">
					<label
						htmlFor={`${dimensionInputId}-y`}
						className="text-[10px] text-muted-foreground w-3"
					>
						Y
					</label>
					<Input
						id={`${dimensionInputId}-y`}
						type="number"
						$size="xs"
						value={localValues.y}
						onChange={(e) => handleDimensionChange("y", e.target.value)}
						onBlur={() => handleDimensionBlur("y")}
						onKeyDown={(e) => handleKeyDown(e, "y")}
						className="font-mono tabular-nums"
					/>
				</div>
			</div>
		</div>
	);
}

/** Fill swatch button that shows solid color or gradient preview */
function ShapeSettingsPanel({
	tooltipSide,
}: {
	tooltipSide: "left" | "right";
}) {
	const t = useTranslation();
	const { tools } = usePaplico();
	const snap = useSnapshot(tools.state);

	const handleShapeTypeChange = useEventCallback((type: ShapeType) => {
		tools.setShapeType(type);
	});

	const shapeOptions: Array<{
		type: ShapeType;
		icon: typeof Square;
		label: string;
	}> = [
		{ type: "rectangle", icon: Square, label: t("toolbar.rectangle") },
		{ type: "ellipse", icon: Circle, label: t("toolbar.ellipse") },
		{ type: "line", icon: Slash, label: t("toolbar.line") },
		{ type: "star", icon: Star, label: t("toolbar.star") },
		{ type: "spiral", icon: Spline, label: t("toolbar.spiral") },
	];

	return (
		<div className="flex flex-col gap-2">
			<div className="grid grid-cols-1">
				{shapeOptions.map(({ type, icon: Icon, label }) => (
					<Tooltip key={type} content={label} side={tooltipSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.shapeType === type}
							onClick={() => handleShapeTypeChange(type)}
							$clickOnPointerUpOnly
						>
							<Icon size={16} />
						</IconButton>
					</Tooltip>
				))}
			</div>
		</div>
	);
}

/** Flyout for the "変形" (Transform) group: pick mesh-deform or skew. */
function TransformSettingsPanel({
	tooltipSide,
	onSelect,
}: {
	tooltipSide: "left" | "right";
	onSelect: (type: "free-transform" | "mesh-deform" | "skew") => void;
}) {
	const t = useTranslation();
	const { tools } = usePaplico();
	const snap = useSnapshot(tools.state);

	const options: Array<{
		type: "free-transform" | "mesh-deform" | "skew";
		icon: typeof Square;
		label: string;
	}> = [
		{
			type: "free-transform",
			icon: Scaling,
			label: t("toolbar.freeTransformTool"),
		},
		{ type: "mesh-deform", icon: Grid3x3, label: t("toolbar.meshDeformTool") },
		{ type: "skew", icon: Italic, label: t("toolbar.skewTool") },
	];

	return (
		<div className="flex flex-col gap-2">
			<div className="grid grid-cols-1">
				{options.map(({ type, icon: Icon, label }) => (
					<Tooltip key={type} content={label} side={tooltipSide}>
						<IconButton
							$size="md"
							$variant="ghost"
							$pressed={snap.currentTool === type}
							onClick={() => onSelect(type)}
							$clickOnPointerUpOnly
						>
							<Icon size={16} />
						</IconButton>
					</Tooltip>
				))}
			</div>
		</div>
	);
}

function BucketFillPanel() {
	const t = useTranslation();
	const paplico = usePaplico();
	const snap = useSnapshot(paplico.tools.state);

	const fill = snap.fillAppearance?.paramData.params.fill;
	const fillColor: Color =
		fill?.type === "solid" ? (fill.color as Color) : createDefaultColor();

	const handleColorChange = useEventCallback((color: Color) => {
		paplico.tools.setFillColor({ type: "solid", color });
	});

	const handleConfirm = useEventCallback(() => {
		const tool = paplico.tools.getCurrentTool();
		if (!(tool instanceof BucketFillTool)) return;
		tool.confirmFill({ type: "solid", color: fillColor });
		paplico.tools.setCurrentTool("select");
	});

	const handleSealFill = useEventCallback(() => {
		const tool = paplico.tools.getCurrentTool();
		if (!(tool instanceof BucketFillTool)) return;
		tool.confirmSealedFill({ type: "solid", color: fillColor });
		paplico.tools.setCurrentTool("select");
	});

	const handleCancel = useEventCallback(() => {
		paplico.tools.getCurrentTool()?.onCancel();
	});

	const recompute = useEventCallback(() => {
		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof BucketFillTool) {
			tool.recomputeAllAreas();
		}
	});

	const debouncedRecompute = useMemo(
		() => debounce(recompute, 200),
		[recompute],
	);

	const handleGapClosingChange = useEventCallback((v: number) => {
		paplico.tools.setBucketFillGapClosing(v);

		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof BucketFillTool) {
			tool.gapClosing = v;
		}
		debouncedRecompute();
	});

	const handleToleranceChange = useEventCallback((v: number) => {
		paplico.tools.setBucketFillTolerance(v);

		const tool = paplico.tools.getCurrentTool();
		if (tool instanceof BucketFillTool) {
			tool.tolerance = v;
		}
		debouncedRecompute();
	});

	return (
		<div className="flex flex-col gap-2 p-1">
			<ColorPickerThin color={fillColor} onColorChange={handleColorChange} />

			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">
						{t("toolbar.bucketFillTolerance")}
					</span>
					<span className="text-[10px] text-foreground font-mono tabular-nums">
						{snap.bucketFillTolerance}
					</span>
				</div>
				<Slider
					min={0}
					max={255}
					step={1}
					value={snap.bucketFillTolerance}
					onValueChange={handleToleranceChange}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">
						{t("toolbar.bucketFillGapClosing")}
					</span>
					<span className="text-[10px] text-foreground font-mono tabular-nums">
						{snap.bucketFillGapClosing}px
					</span>
				</div>
				<Slider
					min={0}
					max={20}
					step={1}
					value={snap.bucketFillGapClosing}
					onValueChange={handleGapClosingChange}
				/>
			</div>

			{snap.bucketFillLeaks && (
				<div className="flex flex-col gap-1">
					<span className="text-xs text-red-400">
						{snap.bucketFillLeaks.noBarriers
							? t("toolbar.bucketFillNoBarriers")
							: snap.bucketFillLeaks.spill
								? t("toolbar.bucketFillArtboardSpill")
								: t("toolbar.bucketFillUnboundedLeaks")}
					</span>
					{snap.bucketFillLeaks.canSealFill && (
						<Button $size="sm" $variant="default" onClick={handleSealFill}>
							{t("toolbar.bucketFillSealAndFill")}
						</Button>
					)}
				</div>
			)}

			<div className="flex gap-1">
				<Button
					$size="sm"
					$variant="default"
					className="flex-1"
					onClick={handleConfirm}
				>
					{t("toolbar.confirmBucketFill")}
				</Button>
				<Button
					$size="sm"
					$variant="ghost"
					className="flex-1"
					onClick={handleCancel}
				>
					{t("toolbar.cancelBucketFill")}
				</Button>
			</div>
		</div>
	);
}
