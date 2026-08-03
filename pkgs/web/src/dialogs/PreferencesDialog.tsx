import { Dialog as BUIDialog } from "@base-ui/react/dialog";
import {
	ChevronLeft,
	ChevronRight,
	Keyboard,
	Monitor,
	PenTool,
	RotateCcw,
	UserCog,
	X,
} from "lucide-react";
import { memo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import { Switch } from "@/components/Switch";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { MAX_TOUCH_DRAW_OFFSET_SCALE } from "@/core/tools/toolSettings";
import {
	DEFAULT_PRESSURE_CURVE,
	evaluatePressureCurve,
	type PressureCurvePoint,
} from "@/core/utils/pressureCurve";
import {
	appConfig,
	type Language,
	type PanelLayout,
	resolveTouchDrawOffsetScale,
	setCollaborationUserName,
	setLanguage,
	setPanelLayout,
	setPressureCurvePoints,
	setTheme,
	setToolbarSide,
	setTouchDrawOffsetEnabled,
	setTouchDrawOffsetScale,
	type Theme,
	type ToolbarSide,
	useAppConfig,
} from "@/hooks/useAppConfig";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { ShortcutsSettings } from "./ShortcutsSettings";

type SectionId = "interface" | "penInput" | "shortcuts" | "account";

const LANGUAGE_OPTIONS = [
	{ label: "English", value: "en" },
	{ label: "日本語", value: "ja" },
] as const;

const SECTIONS: ReadonlyArray<{
	id: SectionId;
	icon: typeof Monitor;
	labelKey: `preferences.${SectionId}`;
}> = [
	{ id: "interface", icon: Monitor, labelKey: "preferences.interface" },
	{ id: "penInput", icon: PenTool, labelKey: "preferences.penInput" },
	{ id: "shortcuts", icon: Keyboard, labelKey: "preferences.shortcuts" },
	{ id: "account", icon: UserCog, labelKey: "preferences.account" },
];

export const PreferencesDialog = memo(function PreferencesDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [activeSection, setActiveSection] = useState<SectionId>("interface");
	// Mobile (< sm) uses a drill-down: section list first, then the detail view.
	const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
	const t = useTranslation();

	const handleOpenChange = useEventCallback((nextOpen: boolean) => {
		if (!nextOpen) setMobileDetailOpen(false);
		onOpenChange(nextOpen);
	});

	const handleSelectSection = useEventCallback((id: SectionId) => {
		setActiveSection(id);
		setMobileDetailOpen(true);
	});

	const handleBackToList = useEventCallback(() => {
		setMobileDetailOpen(false);
	});

	return (
		<BUIDialog.Root open={open} onOpenChange={handleOpenChange}>
			<BUIDialog.Portal>
				<BUIDialog.Backdrop
					className={twm(
						"fixed inset-0 min-h-dvh bg-background/30 backdrop-blur-xs",
						"transition-opacity duration-150",
						"data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
					)}
				/>
				<BUIDialog.Popup
					className={twm(
						"fixed inset-0 w-full h-full",
						"sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2",
						"sm:w-[800px] sm:max-w-[calc(100vw-3rem)] sm:h-[560px] sm:max-h-[calc(100vh-3rem)]",
						"sm:rounded-lg bg-background/95 backdrop-liquid sm:border border-border/50 sm:shadow-xl",
						"outline-none flex overflow-hidden",
						"transition-all duration-150",
						"data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
						"data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
					)}
				>
					{/* Sidebar (desktop) / section list (mobile drill-down root) */}
					<nav
						className={twm(
							"absolute inset-0 sm:static w-full sm:w-[200px] shrink-0 sm:border-r border-border/30 p-3 flex flex-col",
							// Full-screen on a portrait phone: the status bar and the home
							// indicator sit over the dialog. The insets belong on the
							// absolutely positioned children — they span the padding box
							// of the popup, so its own padding would not reach them.
							"max-sm:pt-notch-top max-sm:pb-notch-bottom",
							"transition-[translate,opacity] duration-(--duration-beat) ease-[cubic-bezier(0.32,0.72,0,1)] sm:transition-none",
							// iOS push: the underlying list parallaxes 1/3 left and dims
							mobileDetailOpen
								? "-translate-x-1/3 opacity-50 pointer-events-none sm:translate-x-0 sm:opacity-100 sm:pointer-events-auto"
								: "translate-x-0 opacity-100",
						)}
					>
						<div className="flex items-center justify-between px-2 mb-3">
							<BUIDialog.Title className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
								{t("preferences.title")}
							</BUIDialog.Title>
							<BUIDialog.Close
								className={twm(
									"sm:hidden p-1 rounded hover:bg-foreground/10 transition-colors",
									"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
								)}
							>
								<X size={16} />
							</BUIDialog.Close>
						</div>

						<div className="flex flex-col gap-0.5">
							{SECTIONS.map((section) => (
								<SectionListItem
									key={section.id}
									section={section}
									active={activeSection === section.id}
									onSelect={handleSelectSection}
								/>
							))}
						</div>
					</nav>

					{/* Content (mobile: drill-down detail view) */}
					<div
						className={twm(
							// iOS push: the detail view slides in full-width over the list;
							// opaque on mobile so the list underneath doesn't show through
							"absolute inset-0 sm:static flex-1 flex flex-col min-w-0 max-sm:bg-background",
							"max-sm:pt-safe-top max-sm:pb-safe-bottom",
							"transition-transform duration-(--duration-beat) ease-[cubic-bezier(0.32,0.72,0,1)] sm:transition-none",
							mobileDetailOpen
								? "translate-x-0"
								: "translate-x-full pointer-events-none sm:translate-x-0 sm:pointer-events-auto",
						)}
					>
						{/* Header */}
						<div className="flex items-center gap-2 px-4 sm:px-6 py-4 border-b border-border/30">
							<button
								type="button"
								onClick={handleBackToList}
								className={twm(
									"sm:hidden -ml-1 p-1 rounded hover:bg-foreground/10 transition-colors",
									"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
								)}
								aria-label={t("preferences.title")}
							>
								<ChevronLeft size={18} />
							</button>
							<h2 className="flex-1 text-base font-medium text-foreground">
								{t(`preferences.${activeSection}`)}
							</h2>
							<BUIDialog.Close
								className={twm(
									"p-1 rounded hover:bg-foreground/10 transition-colors",
									"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
								)}
							>
								<X size={16} />
							</BUIDialog.Close>
						</div>

						{/* Settings Content */}
						<div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
							{activeSection === "interface" && <InterfaceSection />}
							{activeSection === "penInput" && <PenInputSection />}
							{activeSection === "shortcuts" && <ShortcutsSettings />}
							{activeSection === "account" && <AccountSection />}
						</div>
					</div>
				</BUIDialog.Popup>
			</BUIDialog.Portal>
		</BUIDialog.Root>
	);
});

const SectionListItem = memo(function SectionListItem({
	section,
	active,
	onSelect,
}: {
	section: (typeof SECTIONS)[number];
	active: boolean;
	onSelect: (id: SectionId) => void;
}) {
	const t = useTranslation();
	const Icon = section.icon;

	const handleClick = useEventCallback(() => {
		onSelect(section.id);
	});

	return (
		<button
			type="button"
			onClick={handleClick}
			className={twm(
				"flex items-center gap-2 px-2 py-2.5 sm:py-1.5 rounded-md text-sm transition-colors text-left",
				active
					? "text-muted-foreground sm:bg-accent/15 sm:text-foreground sm:font-medium"
					: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
			)}
		>
			<Icon size={16} />
			{t(section.labelKey)}
			<ChevronRight
				size={16}
				className="sm:hidden ml-auto text-muted-foreground/60"
			/>
		</button>
	);
});

const InterfaceSection = memo(function InterfaceSection() {
	const settings = useAppConfig();
	const t = useTranslation();

	const handleThemeChange = useEventCallback((v: string) => {
		setTheme(v as Theme);
	});

	const handleLanguageChange = useEventCallback((v: string) => {
		setLanguage(v as Language);
	});

	const handleToolbarSideChange = useEventCallback((v: string) => {
		setToolbarSide(v as ToolbarSide);
	});

	const handlePanelLayoutChange = useEventCallback((v: string) => {
		setPanelLayout(v as PanelLayout);
	});

	return (
		<div className="space-y-6">
			{/* Theme */}
			<SettingRow
				label={t("preferences.theme")}
				description={t("preferences.themeDescription")}
			>
				<SimpleSelect
					items={[
						{ label: t("preferences.themeSystem"), value: "system" },
						{ label: t("preferences.themeDark"), value: "dark" },
						{ label: t("preferences.themeLight"), value: "light" },
						{ label: t("preferences.themePink"), value: "pink" },
						{ label: t("preferences.themeLime"), value: "lime" },
						{ label: t("preferences.themePurple"), value: "purple" },
						{ label: t("preferences.themeBlack"), value: "black" },
						{ label: t("preferences.themeWhite"), value: "white" },
					]}
					value={settings.theme}
					onValueChange={handleThemeChange}
					className="w-[180px]"
				/>
			</SettingRow>

			{/* Language */}
			<SettingRow
				label={t("preferences.language")}
				description={t("preferences.languageDescription")}
			>
				<SimpleSelect
					items={[...LANGUAGE_OPTIONS]}
					value={settings.language}
					onValueChange={handleLanguageChange}
					className="w-[180px]"
				/>
			</SettingRow>

			{/* Toolbar Position */}
			<SettingRow
				label={t("preferences.toolbarSide")}
				description={t("preferences.toolbarSideDescription")}
			>
				<div className="flex gap-2">
					{(["left", "right"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => handleToolbarSideChange(value)}
							className={twm(
								"flex flex-col items-center gap-1.5 p-2 rounded-md border transition-colors",
								settings.toolbarSide === value
									? "border-primary/60 bg-primary/10 text-foreground"
									: "border-border/40 text-muted-foreground hover:border-border hover:text-foreground",
							)}
						>
							<ToolbarSideDiagram side={value} />
							<span className="text-xs">
								{value === "left"
									? t("preferences.toolbarSideLeft")
									: t("preferences.toolbarSideRight")}
							</span>
						</button>
					))}
				</div>
			</SettingRow>

			{/* Panel Arrangement */}
			<SettingRow
				label={t("preferences.panelLayout")}
				description={t("preferences.panelLayoutDescription")}
			>
				<div className="flex gap-2">
					{(["together", "split"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => handlePanelLayoutChange(value)}
							className={twm(
								"flex flex-col items-center gap-1.5 p-2 rounded-md border transition-colors",
								settings.panelLayout === value
									? "border-primary/60 bg-primary/10 text-foreground"
									: "border-border/40 text-muted-foreground hover:border-border hover:text-foreground",
							)}
						>
							<PanelLayoutDiagram
								layout={value}
								toolbarSide={settings.toolbarSide}
							/>
							<span className="text-xs">
								{value === "together"
									? t("preferences.panelLayoutTogether")
									: t("preferences.panelLayoutSplit")}
							</span>
						</button>
					))}
				</div>
			</SettingRow>
		</div>
	);
});

const PenInputSection = memo(function PenInputSection() {
	const settings = useAppConfig();
	const paplico = usePaplicoMaybe();
	const t = useTranslation();

	const handlePressureCurveChange = useEventCallback(
		(points: PressureCurvePoint[]) => {
			setPressureCurvePoints(points);
			paplico?.tools.setPressureCurve(points);
		},
	);

	const handleTouchDrawOffsetEnabledChange = useEventCallback(
		(enabled: boolean) => {
			setTouchDrawOffsetEnabled(enabled);
			paplico?.tools.setTouchDrawOffsetScale(resolveTouchDrawOffsetScale());
		},
	);

	const handleTouchDrawOffsetScaleChange = useEventCallback((scale: number) => {
		setTouchDrawOffsetScale(scale);
		paplico?.tools.setTouchDrawOffsetScale(resolveTouchDrawOffsetScale());
	});

	return (
		<div className="space-y-6">
			<SettingRow
				label={t("preferences.pressureCurve")}
				description={t("preferences.pressureCurveDescription")}
			>
				<PressureCurveEditor
					value={settings.pressureCurvePoints}
					onChange={handlePressureCurveChange}
				/>
			</SettingRow>

			<SettingRow
				label={t("preferences.touchDrawOffset")}
				description={t("preferences.touchDrawOffsetDescription")}
			>
				<Switch
					checked={settings.touchDrawOffsetEnabled}
					onCheckedChange={handleTouchDrawOffsetEnabledChange}
				/>
			</SettingRow>

			<SettingRow
				label={t("preferences.touchDrawOffsetScale")}
				description={t("preferences.touchDrawOffsetScaleDescription")}
			>
				<div className="flex w-[180px] items-center gap-3">
					<Slider
						min={0}
						max={MAX_TOUCH_DRAW_OFFSET_SCALE}
						step={0.1}
						value={settings.touchDrawOffsetScale}
						onValueChange={handleTouchDrawOffsetScaleChange}
						disabled={!settings.touchDrawOffsetEnabled}
					/>
					<span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
						{settings.touchDrawOffsetScale.toFixed(1)}×
					</span>
				</div>
			</SettingRow>
		</div>
	);
});

const isCloudMode = process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud";

const AccountSection = memo(function AccountSection() {
	const [localName, setLocalName] = useState(appConfig.collaborationUserName);
	const [isDeleting, setIsDeleting] = useState(false);
	const session = useUserSession();
	const t = useTranslation();

	const handleChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setLocalName(e.target.value);
		},
	);

	const handleBlur = useEventCallback(() => {
		setCollaborationUserName(localName);
	});

	const handleDeleteAccount = useEventCallback(async () => {
		if (!(await confirm(t("preferences.deleteAccountConfirm")))) return;

		setIsDeleting(true);
		try {
			await session.deleteAccount();
		} catch (e) {
			console.error("Failed to delete account:", e);
			setIsDeleting(false);
		}
	});

	return (
		<div className="space-y-6">
			<SettingRow
				label={t("preferences.collaborationUserName")}
				description={t("preferences.collaborationUserNameDescription")}
			>
				<Input
					$size="sm"
					value={localName}
					onChange={handleChange}
					onBlur={handleBlur}
					placeholder={t("preferences.collaborationUserNamePlaceholder")}
					className="w-[180px]"
				/>
			</SettingRow>

			{isCloudMode && session.isSignedIn && (
				<>
					<hr className="border-border/30" />

					<SettingRow
						label={t("preferences.deleteAccount")}
						description={t("preferences.deleteAccountDescription")}
					>
						<Button
							$variant="destructive"
							$size="sm"
							disabled={isDeleting}
							onClick={handleDeleteAccount}
						>
							{isDeleting
								? t("preferences.deleting")
								: t("preferences.deleteAccountButton")}
						</Button>
					</SettingRow>
				</>
			)}
		</div>
	);
});

function SettingRow({
	label,
	description,
	children,
}: {
	label: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
			<div className="flex-1 min-w-0">
				<div className="text-sm font-medium text-foreground">{label}</div>
				<div className="text-xs text-muted-foreground mt-0.5">
					{description}
				</div>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

const ToolbarSideDiagram = memo(function ToolbarSideDiagram({
	side,
}: {
	side: "left" | "right";
}) {
	const toolbar = (
		<div className="w-[6px] h-full bg-current rounded-[1px] opacity-60 shrink-0" />
	);
	const canvas = (
		<div className="flex-1 h-full bg-current rounded-[1px] opacity-15" />
	);
	const panel = (
		<div className="w-[9px] h-full bg-current rounded-[1px] opacity-40 shrink-0" />
	);

	return (
		<div className="w-14 h-9 flex gap-[2px] p-1 rounded border border-current/20 bg-current/5">
			{side === "left" ? (
				<>
					{toolbar}
					{canvas}
					{panel}
				</>
			) : (
				<>
					{panel}
					{canvas}
					{toolbar}
				</>
			)}
		</div>
	);
});

const PanelLayoutDiagram = memo(function PanelLayoutDiagram({
	layout,
	toolbarSide,
}: {
	layout: "together" | "split";
	toolbarSide: "left" | "right";
}) {
	const toolbar = (
		<div className="w-[6px] h-full bg-current rounded-[1px] opacity-60 shrink-0" />
	);
	const canvas = (
		<div className="flex-1 h-full bg-current rounded-[1px] opacity-15" />
	);
	const panel = (
		<div className="w-[9px] h-full bg-current rounded-[1px] opacity-40 shrink-0" />
	);

	// together: panels next to toolbar (same side)
	// split: panels on the opposite side from toolbar
	const isLeft = toolbarSide === "left";

	return (
		<div className="w-14 h-9 flex gap-[2px] p-1 rounded border border-current/20 bg-current/5">
			{isLeft ? (
				layout === "together" ? (
					<>
						{toolbar}
						{panel}
						{canvas}
					</>
				) : (
					<>
						{toolbar}
						{canvas}
						{panel}
					</>
				)
			) : layout === "together" ? (
				<>
					{canvas}
					{panel}
					{toolbar}
				</>
			) : (
				<>
					{panel}
					{canvas}
					{toolbar}
				</>
			)}
		</div>
	);
});

const SVG_WIDTH = 200;
const SVG_HEIGHT = 160;
const PAD = 8;
const PLOT_WIDTH = SVG_WIDTH - PAD * 2;
const PLOT_HEIGHT = SVG_HEIGHT - PAD * 2;
const CURVE_SAMPLES = 64;
/** Pointer distance (svg units) within which a control point is grabbed */
const HIT_RADIUS = 8;
/** Client px outside the svg bounds beyond which a dragged point is removed */
const REMOVE_DISTANCE_PX = 24;
/** Minimum x gap kept between an interior point and its neighbors */
const NEIGHBOR_X_GAP = 0.01;

/**
 * Pressure curve editor: control points on a 0..1 grid, draggable via
 * pointer capture. Endpoints move on y only; interior points can be added
 * by clicking the background and removed by double-click or by dragging
 * them far outside the plot.
 */
const PressureCurveEditor = memo(function PressureCurveEditor({
	value,
	onChange,
	className,
}: {
	value: readonly PressureCurvePoint[];
	onChange: (points: PressureCurvePoint[]) => void;
	className?: string;
}) {
	const t = useTranslation();
	const svgRef = useRef<SVGSVGElement>(null);
	const draggingRef = useRef<{
		index: number;
		removedPoint: PressureCurvePoint | null;
	} | null>(null);
	// A point inserted by pointerdown must not be removed by the dblclick that
	// the same double-tap on the background would otherwise trigger.
	const suppressDoubleClickRef = useRef(false);

	const handlePointerDown = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			if (draggingRef.current) return;
			const svg = svgRef.current;
			if (!svg) return;

			const pos = clientToCurve(e, svg.getBoundingClientRect());
			const hitIndex = hitTestPointIndex(value, pos.svgX, pos.svgY);
			suppressDoubleClickRef.current = false;

			if (hitIndex >= 0) {
				draggingRef.current = { index: hitIndex, removedPoint: null };
				svg.setPointerCapture(e.pointerId);
				return;
			}

			// Insert a new point on the curve at the clicked x and start dragging it
			const inserted = {
				x: Math.min(1 - NEIGHBOR_X_GAP, Math.max(NEIGHBOR_X_GAP, pos.x)),
				y: evaluatePressureCurve(value, pos.x),
			};
			const next = [...value, inserted].sort((a, b) => a.x - b.x);
			suppressDoubleClickRef.current = true;
			onChange(next);
			draggingRef.current = {
				index: next.indexOf(inserted),
				removedPoint: null,
			};
			svg.setPointerCapture(e.pointerId);
		},
	);

	const handlePointerMove = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			const drag = draggingRef.current;
			if (!drag) return;
			const svg = svgRef.current;
			if (!svg) return;

			const rect = svg.getBoundingClientRect();
			const pos = clientToCurve(e, rect);
			const isFarOutside =
				e.clientX < rect.left - REMOVE_DISTANCE_PX ||
				e.clientX > rect.right + REMOVE_DISTANCE_PX ||
				e.clientY < rect.top - REMOVE_DISTANCE_PX ||
				e.clientY > rect.bottom + REMOVE_DISTANCE_PX;

			if (drag.removedPoint) {
				// Hidden while outside; re-insert when the pointer comes back
				if (isFarOutside) return;
				const restored = {
					x: Math.min(1 - NEIGHBOR_X_GAP, Math.max(NEIGHBOR_X_GAP, pos.x)),
					y: pos.y,
				};
				const next = [...value, restored].sort((a, b) => a.x - b.x);
				drag.index = next.indexOf(restored);
				drag.removedPoint = null;
				onChange(next);
				return;
			}

			const isEndpoint = drag.index === 0 || drag.index === value.length - 1;
			if (isFarOutside && !isEndpoint) {
				drag.removedPoint = { ...value[drag.index] };
				onChange(value.filter((_, i) => i !== drag.index));
				return;
			}

			onChange(
				value.map((p, i) =>
					i === drag.index ? clampDraggedPoint(value, drag.index, pos) : p,
				),
			);
		},
	);

	const handlePointerUp = useEventCallback(
		(e: React.PointerEvent<SVGSVGElement>) => {
			const svg = svgRef.current;
			if (svg?.hasPointerCapture(e.pointerId)) {
				svg.releasePointerCapture(e.pointerId);
			}
			draggingRef.current = null;
		},
	);

	const handleDoubleClick = useEventCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			if (suppressDoubleClickRef.current) {
				suppressDoubleClickRef.current = false;
				return;
			}
			const svg = svgRef.current;
			if (!svg) return;

			const pos = clientToCurve(e, svg.getBoundingClientRect());
			const hitIndex = hitTestPointIndex(value, pos.svgX, pos.svgY);
			if (hitIndex <= 0 || hitIndex >= value.length - 1) return;

			onChange(value.filter((_, i) => i !== hitIndex));
		},
	);

	const handleReset = useEventCallback(() => {
		onChange(DEFAULT_PRESSURE_CURVE.map((p) => ({ ...p })));
	});

	const curvePath = Array.from({ length: CURVE_SAMPLES }, (_, i) => {
		const x = i / (CURVE_SAMPLES - 1);
		return `${toSvgX(x)},${toSvgY(evaluatePressureCurve(value, x))}`;
	}).join(" ");

	return (
		<div
			className={twm("flex flex-col items-start sm:items-end gap-2", className)}
		>
			<svg
				ref={svgRef}
				width={SVG_WIDTH}
				height={SVG_HEIGHT}
				viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
				role="img"
				aria-label={t("preferences.pressureCurve")}
				className="touch-none cursor-crosshair select-none rounded border border-border/40 bg-background/50"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				onDoubleClick={handleDoubleClick}
			>
				<title>{t("preferences.pressureCurve")}</title>
				{/* Quarter grid */}
				{[0.25, 0.5, 0.75].map((step) => (
					<g key={step} className="stroke-border/50">
						<line
							x1={toSvgX(step)}
							y1={toSvgY(0)}
							x2={toSvgX(step)}
							y2={toSvgY(1)}
						/>
						<line
							x1={toSvgX(0)}
							y1={toSvgY(step)}
							x2={toSvgX(1)}
							y2={toSvgY(step)}
						/>
					</g>
				))}
				<rect
					x={PAD}
					y={PAD}
					width={PLOT_WIDTH}
					height={PLOT_HEIGHT}
					className="fill-none stroke-border/50"
				/>

				{/* Identity diagonal */}
				<line
					x1={toSvgX(0)}
					y1={toSvgY(0)}
					x2={toSvgX(1)}
					y2={toSvgY(1)}
					strokeDasharray="3 3"
					className="stroke-muted-foreground/50"
				/>

				{/* Interpolated curve (same interpolation as the runtime) */}
				<polyline
					points={curvePath}
					strokeWidth={1.5}
					className="fill-none stroke-accent"
				/>

				{/* Control points */}
				{value.map((point, i) => (
					<circle
						key={i}
						cx={toSvgX(point.x)}
						cy={toSvgY(point.y)}
						r={4}
						strokeWidth={1.5}
						className="fill-accent stroke-background"
					/>
				))}
			</svg>

			<div className="flex w-full flex-col gap-1">
				<span className="text-[10px] text-muted-foreground">
					{t("preferences.pressureCurvePreview")}
				</span>
				<PressureCurvePreview value={value} />
			</div>

			<Button $variant="ghost" $size="sm" onClick={handleReset}>
				<RotateCcw size={14} />
				{t("preferences.pressureCurveReset")}
			</Button>
		</div>
	);
});

const PREVIEW_WIDTH = SVG_WIDTH;
const PREVIEW_HEIGHT = 40;
const PREVIEW_SAMPLES = 48;
const PREVIEW_MAX_HALF_WIDTH = PREVIEW_HEIGHT * 0.42;

/**
 * Rough stroke preview: a taper-in/taper-out input pressure profile
 * (sin curve) run through the same pressure curve as the runtime, drawn
 * as a variable-width ribbon. Not a real brush render — just a feel hint.
 */
const PressureCurvePreview = memo(function PressureCurvePreview({
	value,
	className,
}: {
	value: readonly PressureCurvePoint[];
	className?: string;
}) {
	const centerY = PREVIEW_HEIGHT / 2;
	const upper: string[] = [];
	const lower: string[] = [];
	for (let i = 0; i < PREVIEW_SAMPLES; i++) {
		const t = i / (PREVIEW_SAMPLES - 1);
		const inputPressure = Math.sin(Math.PI * t);
		const output = evaluatePressureCurve(value, inputPressure);
		const halfWidth = PREVIEW_MAX_HALF_WIDTH * output;
		const x = PAD + t * (PREVIEW_WIDTH - PAD * 2);
		upper.push(`${x},${centerY - halfWidth}`);
		lower.unshift(`${x},${centerY + halfWidth}`);
	}

	return (
		<svg
			width={PREVIEW_WIDTH}
			height={PREVIEW_HEIGHT}
			viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
			className={twm(
				"select-none rounded border border-border/40 bg-background/50",
				className,
			)}
			aria-hidden="true"
			role="presentation"
		>
			<polygon
				points={[...upper, ...lower].join(" ")}
				className="fill-foreground/80"
			/>
		</svg>
	);
});

function toSvgX(x: number): number {
	return PAD + x * PLOT_WIDTH;
}

function toSvgY(y: number): number {
	return SVG_HEIGHT - PAD - y * PLOT_HEIGHT;
}

/** Convert a client position to curve coordinates (clamped) + raw svg units */
function clientToCurve(
	e: { clientX: number; clientY: number },
	rect: DOMRect,
): { x: number; y: number; svgX: number; svgY: number } {
	const svgX = ((e.clientX - rect.left) / rect.width) * SVG_WIDTH;
	const svgY = ((e.clientY - rect.top) / rect.height) * SVG_HEIGHT;
	return {
		x: clamp01((svgX - PAD) / PLOT_WIDTH),
		y: clamp01((SVG_HEIGHT - PAD - svgY) / PLOT_HEIGHT),
		svgX,
		svgY,
	};
}

function hitTestPointIndex(
	points: readonly PressureCurvePoint[],
	svgX: number,
	svgY: number,
): number {
	let bestIndex = -1;
	let bestDistance = HIT_RADIUS;
	points.forEach((point, i) => {
		const distance = Math.hypot(toSvgX(point.x) - svgX, toSvgY(point.y) - svgY);
		if (distance <= bestDistance) {
			bestDistance = distance;
			bestIndex = i;
		}
	});
	return bestIndex;
}

/** Endpoints move on y only; interior x stays between its neighbors */
function clampDraggedPoint(
	points: readonly PressureCurvePoint[],
	index: number,
	pos: { x: number; y: number },
): PressureCurvePoint {
	if (index === 0) return { x: 0, y: pos.y };
	if (index === points.length - 1) return { x: 1, y: pos.y };

	const minX = points[index - 1].x + NEIGHBOR_X_GAP;
	const maxX = points[index + 1].x - NEIGHBOR_X_GAP;
	return { x: Math.min(maxX, Math.max(minX, pos.x)), y: pos.y };
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}
