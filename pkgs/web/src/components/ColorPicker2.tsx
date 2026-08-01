import { Slider as BUISlider } from "@base-ui/react/slider";
import { Check, Copy, Pipette } from "lucide-react";
import {
	createContext,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { tv } from "tailwind-variants";
import { ToggleGroup } from "@/components/ToggleGroup";
import {
	type Color,
	type HSVColor,
	hsvToRgb,
	type RGBColor,
	rgbToHsv,
} from "@/core/schema";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

// ─── Styles ─────────────────────────────────────────────────────────────────

const sliderStyles = tv({
	slots: {
		root: "relative flex items-center",
		track: "w-full rounded-full",
		thumb:
			"block size-4 cursor-pointer rounded-full border-2 border-white shadow-md",
	},
	variants: {
		size: {
			sm: { root: "h-2.5", track: "h-2.5", thumb: "size-3" },
			md: { root: "h-3", track: "h-3", thumb: "size-4" },
			// The track stays slim; the row around it is what a finger has to
			// land on, so that is what grows.
			lg: { root: "h-11", track: "h-3", thumb: "size-6" },
		},
	},
	defaultVariants: {
		size: "md",
	},
});

const saturationStyles = tv({
	base: ["relative w-full cursor-crosshair select-none rounded-t-lg"],
	variants: {
		height: {
			sm: "h-32",
			md: "h-40",
			lg: "h-48",
		},
	},
	defaultVariants: {
		height: "md",
	},
});

const saturationPointerStyles = tv({
	base: [
		"pointer-events-none absolute size-4",
		"-translate-x-1/2 -translate-y-1/2",
		"rounded-full border-2 border-white shadow-md",
	],
});

const eyeDropperStyles = tv({
	base: [
		"inline-flex items-center justify-center rounded-md p-1.5",
		"text-muted-foreground",
		"hover:bg-accent hover:text-accent-foreground",
	],
});

const swatchStyles = tv({
	base: "rounded-md",
	variants: {
		size: {
			sm: "size-6",
			md: "size-8",
			lg: "size-10",
		},
	},
	defaultVariants: {
		size: "md",
	},
});

const channelInputStyles = tv({
	slots: {
		input: [
			"w-10 rounded border border-border bg-background",
			"px-1 py-0.5 text-xs text-center font-mono text-foreground",
			"[appearance:textfield]",
			"[&::-webkit-inner-spin-button]:appearance-none",
			"[&::-webkit-outer-spin-button]:appearance-none",
		],
		label: "text-[10px] text-muted-foreground text-center",
		modeButton: [
			"mb-0.5 rounded px-1 py-0.5",
			"text-[10px] font-semibold text-muted-foreground",
			"hover:bg-accent",
		],
	},
});

const hexInputStyles = tv({
	base: [
		"w-[4.5rem] rounded border border-border bg-background",
		"px-1.5 py-0.5 text-xs font-mono text-foreground",
	],
});

// ─── HSVA type ──────────────────────────────────────────────────────────────

interface HSVA {
	h: number;
	s: number;
	v: number;
	a: number;
}

function colorToHsva(c: Color, hueMemoryH: number): HSVA {
	if (c.type === "hsv") {
		const effectiveH = c.s === 0 || c.v === 0 ? hueMemoryH : c.h;
		return { h: effectiveH, s: c.s, v: c.v, a: c.a };
	}
	const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
	const effectiveH = s === 0 || v === 0 ? hueMemoryH : h;
	return { h: effectiveH, s, v, a: c.a };
}

// EyeDropper API type (not yet in all TS libs)
declare global {
	interface Window {
		EyeDropper?: {
			new (): { open(): Promise<{ sRGBHex: string }> };
		};
	}
}

// ─── Context ────────────────────────────────────────────────────────────────

interface ColorPickerCtx {
	hsva: HSVA;
	setHsva: (hsva: HSVA) => void;
	mode: "rgba" | "hsva";
	onColorChange: (color: Color) => void;
	disabled: boolean;
	touch: boolean;
}

const Ctx = createContext<ColorPickerCtx | null>(null);

function useColorPickerCtx(): ColorPickerCtx {
	const ctx = useContext(Ctx);
	if (!ctx)
		throw new Error(
			"ColorPicker2 sub-components must be used inside ColorPicker2.Root",
		);
	return ctx;
}

// ─── Root ───────────────────────────────────────────────────────────────────

function Root({
	color,
	onColorChange,
	disabled = false,
	touch = false,
	children,
}: {
	color: Color;
	onColorChange: (color: Color) => void;
	disabled?: boolean;
	/**
	 * Size the controls for a fingertip and stop drags from scrolling the page.
	 * Off by default: on a pointer device the roomier layout only wastes space.
	 */
	touch?: boolean;
	children: React.ReactNode;
}) {
	const mode = color.type === "hsv" ? "hsva" : "rgba";

	const hueMemory = useRef(0);
	const suppressSync = useRef(false);

	const [hsva, setHsvaRaw] = useState<HSVA>(() => {
		const initial = colorToHsva(color, 0);
		hueMemory.current = initial.h;
		return initial;
	});

	const onColorChangeRef = useRef(onColorChange);
	onColorChangeRef.current = onColorChange;

	const setHsva = useEventCallback((next: HSVA) => {
		if (next.s > 0 && next.v > 0) {
			hueMemory.current = next.h;
		}
		setHsvaRaw(next);

		const [r, g, b] = hsvToRgb(next.h, next.s, next.v);
		suppressSync.current = true;

		if (mode === "hsva") {
			onColorChangeRef.current({
				type: "hsv",
				h: next.h,
				s: next.s,
				v: next.v,
				a: next.a,
			} satisfies HSVColor);
		} else {
			onColorChangeRef.current({
				type: "rgb",
				r,
				g,
				b,
				a: next.a,
			} satisfies RGBColor);
		}
	});

	const onColorChangeMemo = useEventCallback(onColorChange);

	// Sync external color prop changes into internal HSVA
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional granular deps to avoid re-syncing on identity change
	useEffect(() => {
		if (suppressSync.current) {
			suppressSync.current = false;
			return;
		}
		const next = colorToHsva(color, hueMemory.current);
		setHsvaRaw(next);
		if (next.s > 0 && next.v > 0) {
			hueMemory.current = next.h;
		}
	}, [
		color.type === "rgb" ? color.r : color.h,
		color.type === "rgb" ? color.g : color.s,
		color.type === "rgb" ? color.b : color.v,
		color.a,
	]);

	return (
		<Ctx.Provider
			value={{
				hsva,
				setHsva,
				mode,
				onColorChange: onColorChangeMemo,
				disabled,
				touch,
			}}
		>
			{children}
		</Ctx.Provider>
	);
}

// ─── Saturation ─────────────────────────────────────────────────────────────

const Saturation = memo(function Saturation({
	className,
}: {
	className?: string;
}) {
	const { hsva, setHsva, disabled, touch } = useColorPickerCtx();
	const containerRef = useRef<HTMLDivElement>(null);

	const updateFromPointer = useEventCallback(
		(e: PointerEvent | React.PointerEvent) => {
			if (disabled) return;
			const rect = containerRef.current?.getBoundingClientRect();
			if (!rect) return;
			const s = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
			const v = Math.min(
				1,
				Math.max(0, 1 - (e.clientY - rect.top) / rect.height),
			);
			setHsva({ ...hsva, s, v });
		},
	);

	const handlePointerDown = useEventCallback((e: React.PointerEvent) => {
		if (disabled) return;
		e.preventDefault();
		updateFromPointer(e);

		const onMove = (ev: PointerEvent) => updateFromPointer(ev);
		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	});

	const hueColor = `hsl(${hsva.h * 360}, 100%, 50%)`;

	return (
		<div
			ref={containerRef}
			// Without touch-action:none a drag across this square is claimed by the
			// scroller above it, and the colour never moves.
			className={twm(saturationStyles({ className }), touch && "touch-none")}
			style={{
				background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
				opacity: disabled ? 0.4 : undefined,
				pointerEvents: disabled ? "none" : undefined,
			}}
			onPointerDown={handlePointerDown}
		>
			<div
				className={saturationPointerStyles()}
				style={{
					left: `${hsva.s * 100}%`,
					top: `${(1 - hsva.v) * 100}%`,
				}}
			/>
		</div>
	);
});

// ─── Hue ────────────────────────────────────────────────────────────────────

const HUE_GRADIENT =
	"linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)";

const Hue = memo(function Hue() {
	const { hsva, setHsva, disabled, touch } = useColorPickerCtx();
	const styles = sliderStyles({ size: touch ? "lg" : "md" });
	const inputStyles = channelInputStyles();

	const handleChange = useEventCallback((v: number | number[]) => {
		const val = Array.isArray(v) ? v[0] : v;
		setHsva({ ...hsva, h: val });
	});

	const handleInput = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const n = Number.parseFloat(e.target.value);
			if (Number.isNaN(n)) return;
			setHsva({ ...hsva, h: Math.min(1, Math.max(0, n / 360)) });
		},
	);

	return (
		<div className="flex items-center gap-2">
			<BUISlider.Root
				className="flex-1"
				value={hsva.h}
				onValueChange={handleChange}
				min={0}
				max={1}
				step={0.001}
				disabled={disabled}
			>
				<BUISlider.Control
					className={styles.root()}
					style={{ opacity: disabled ? 0.4 : undefined }}
				>
					<BUISlider.Track
						className={styles.track()}
						style={{ background: HUE_GRADIENT }}
					>
						<BUISlider.Thumb className={styles.thumb()} />
					</BUISlider.Track>
				</BUISlider.Control>
			</BUISlider.Root>
			<input
				type="number"
				value={Math.round(hsva.h * 360)}
				min={0}
				max={360}
				step={1}
				onChange={handleInput}
				className={inputStyles.input()}
				disabled={disabled}
			/>
		</div>
	);
});

// ─── Alpha ──────────────────────────────────────────────────────────────────

const CHECKER_BG =
	"repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px";

const Alpha = memo(function Alpha() {
	const { hsva, setHsva, disabled, touch } = useColorPickerCtx();
	const styles = sliderStyles({ size: touch ? "lg" : "md" });
	const inputStyles = channelInputStyles();

	const handleChange = useEventCallback((v: number | number[]) => {
		const val = Array.isArray(v) ? v[0] : v;
		setHsva({ ...hsva, a: val });
	});

	const handleInput = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const n = Number.parseFloat(e.target.value);
			if (Number.isNaN(n)) return;
			setHsva({ ...hsva, a: Math.min(1, Math.max(0, n / 100)) });
		},
	);

	const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);
	const opaqueColor = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

	return (
		<div className="flex items-center gap-2">
			<BUISlider.Root
				className="flex-1"
				value={hsva.a}
				onValueChange={handleChange}
				min={0}
				max={1}
				step={0.001}
				disabled={disabled}
			>
				<BUISlider.Control
					className={styles.root()}
					style={{ opacity: disabled ? 0.4 : undefined }}
				>
					<BUISlider.Track
						className={styles.track()}
						style={{
							background: `linear-gradient(to right, transparent, ${opaqueColor}), ${CHECKER_BG}`,
						}}
					>
						<BUISlider.Thumb className={styles.thumb()} />
					</BUISlider.Track>
				</BUISlider.Control>
			</BUISlider.Root>
			<input
				type="number"
				value={Math.round(hsva.a * 100)}
				min={0}
				max={100}
				step={1}
				onChange={handleInput}
				className={inputStyles.input()}
				disabled={disabled}
			/>
		</div>
	);
});

// ─── SaturationSlider ────────────────────────────────────────────────────────

const SaturationSlider = memo(function SaturationSlider() {
	const { hsva, setHsva, disabled, touch } = useColorPickerCtx();
	const styles = sliderStyles({ size: touch ? "lg" : "md" });
	const inputStyles = channelInputStyles();

	const handleChange = useEventCallback((v: number | number[]) => {
		const val = Array.isArray(v) ? v[0] : v;
		setHsva({ ...hsva, s: val });
	});

	const handleInput = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const n = Number.parseFloat(e.target.value);
			if (Number.isNaN(n)) return;
			setHsva({ ...hsva, s: Math.min(1, Math.max(0, n / 100)) });
		},
	);

	const [rFull, gFull, bFull] = hsvToRgb(hsva.h, 1, hsva.v);
	const fullColor = `rgb(${Math.round(rFull * 255)}, ${Math.round(gFull * 255)}, ${Math.round(bFull * 255)})`;
	const [rGray, gGray, bGray] = hsvToRgb(hsva.h, 0, hsva.v);
	const grayColor = `rgb(${Math.round(rGray * 255)}, ${Math.round(gGray * 255)}, ${Math.round(bGray * 255)})`;

	return (
		<div className="flex items-center gap-2">
			<BUISlider.Root
				className="flex-1"
				value={hsva.s}
				onValueChange={handleChange}
				min={0}
				max={1}
				step={0.001}
				disabled={disabled}
			>
				<BUISlider.Control
					className={styles.root()}
					style={{ opacity: disabled ? 0.4 : undefined }}
				>
					<BUISlider.Track
						className={styles.track()}
						style={{
							background: `linear-gradient(to right, ${grayColor}, ${fullColor})`,
						}}
					>
						<BUISlider.Thumb className={styles.thumb()} />
					</BUISlider.Track>
				</BUISlider.Control>
			</BUISlider.Root>
			<input
				type="number"
				value={Math.round(hsva.s * 100)}
				min={0}
				max={100}
				step={1}
				onChange={handleInput}
				className={inputStyles.input()}
				disabled={disabled}
			/>
		</div>
	);
});

// ─── ValueSlider ─────────────────────────────────────────────────────────────

const ValueSlider = memo(function ValueSlider() {
	const { hsva, setHsva, disabled, touch } = useColorPickerCtx();
	const styles = sliderStyles({ size: touch ? "lg" : "md" });
	const inputStyles = channelInputStyles();

	const handleChange = useEventCallback((v: number | number[]) => {
		const val = Array.isArray(v) ? v[0] : v;
		setHsva({ ...hsva, v: val });
	});

	const handleInput = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const n = Number.parseFloat(e.target.value);
			if (Number.isNaN(n)) return;
			setHsva({ ...hsva, v: Math.min(1, Math.max(0, n / 100)) });
		},
	);

	const [rBright, gBright, bBright] = hsvToRgb(hsva.h, hsva.s, 1);
	const brightColor = `rgb(${Math.round(rBright * 255)}, ${Math.round(gBright * 255)}, ${Math.round(bBright * 255)})`;

	return (
		<div className="flex items-center gap-2">
			<BUISlider.Root
				className="flex-1"
				value={hsva.v}
				onValueChange={handleChange}
				min={0}
				max={1}
				step={0.001}
				disabled={disabled}
			>
				<BUISlider.Control
					className={styles.root()}
					style={{ opacity: disabled ? 0.4 : undefined }}
				>
					<BUISlider.Track
						className={styles.track()}
						style={{
							background: `linear-gradient(to right, #000, ${brightColor})`,
						}}
					>
						<BUISlider.Thumb className={styles.thumb()} />
					</BUISlider.Track>
				</BUISlider.Control>
			</BUISlider.Root>
			<input
				type="number"
				value={Math.round(hsva.v * 100)}
				min={0}
				max={100}
				step={1}
				onChange={handleInput}
				className={inputStyles.input()}
				disabled={disabled}
			/>
		</div>
	);
});

// ─── RgbSliders ──────────────────────────────────────────────────────────────

const RgbSliders = memo(function RgbSliders() {
	const { hsva, setHsva, disabled, touch } = useColorPickerCtx();
	const styles = sliderStyles({ size: touch ? "lg" : "md" });
	const inputStyles = channelInputStyles();

	const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);

	const makeSliderHandler =
		(channel: "r" | "g" | "b") => (v: number | number[]) => {
			const val = Array.isArray(v) ? v[0] : v;
			const nr = channel === "r" ? val : r;
			const ng = channel === "g" ? val : g;
			const nb = channel === "b" ? val : b;
			const [h, s, vv] = rgbToHsv(nr, ng, nb);
			setHsva({ h: s === 0 || vv === 0 ? hsva.h : h, s, v: vv, a: hsva.a });
		};

	const makeInputHandler =
		(channel: "r" | "g" | "b") => (e: React.ChangeEvent<HTMLInputElement>) => {
			const n = Number.parseFloat(e.target.value);
			if (Number.isNaN(n)) return;
			const nr = channel === "r" ? n / 255 : r;
			const ng = channel === "g" ? n / 255 : g;
			const nb = channel === "b" ? n / 255 : b;
			const clamped = [
				Math.min(1, Math.max(0, nr)),
				Math.min(1, Math.max(0, ng)),
				Math.min(1, Math.max(0, nb)),
			] as const;
			const [h, s, vv] = rgbToHsv(clamped[0], clamped[1], clamped[2]);
			setHsva({
				h: s === 0 || vv === 0 ? hsva.h : h,
				s,
				v: vv,
				a: hsva.a,
			});
		};

	const ri = Math.round(r * 255);
	const gi = Math.round(g * 255);
	const bi = Math.round(b * 255);

	const channels = [
		{
			label: "R",
			value: r,
			display: ri,
			gradient: `linear-gradient(to right, rgb(0,${gi},${bi}), rgb(255,${gi},${bi}))`,
			sliderHandler: makeSliderHandler("r"),
			inputHandler: makeInputHandler("r"),
		},
		{
			label: "G",
			value: g,
			display: gi,
			gradient: `linear-gradient(to right, rgb(${ri},0,${bi}), rgb(${ri},255,${bi}))`,
			sliderHandler: makeSliderHandler("g"),
			inputHandler: makeInputHandler("g"),
		},
		{
			label: "B",
			value: b,
			display: bi,
			gradient: `linear-gradient(to right, rgb(${ri},${gi},0), rgb(${ri},${gi},255))`,
			sliderHandler: makeSliderHandler("b"),
			inputHandler: makeInputHandler("b"),
		},
	] as const;

	return (
		<>
			{channels.map(
				({ label, value, display, gradient, sliderHandler, inputHandler }) => (
					<div key={label} className="flex items-center gap-2">
						<BUISlider.Root
							className="flex-1"
							value={value}
							onValueChange={sliderHandler}
							min={0}
							max={1}
							step={0.001}
							disabled={disabled}
						>
							<BUISlider.Control
								className={styles.root()}
								style={{ opacity: disabled ? 0.4 : undefined }}
							>
								<BUISlider.Track
									className={styles.track()}
									style={{ background: gradient }}
								>
									<BUISlider.Thumb className={styles.thumb()} />
								</BUISlider.Track>
							</BUISlider.Control>
						</BUISlider.Root>
						<input
							type="number"
							value={display}
							min={0}
							max={255}
							step={1}
							onChange={inputHandler}
							className={inputStyles.input()}
							disabled={disabled}
						/>
					</div>
				),
			)}
		</>
	);
});

// ─── ModeSliders ──────────────────────────────────────────────────────────────

const ModeSliders = memo(function ModeSliders() {
	const { mode } = useColorPickerCtx();
	if (mode === "rgba") {
		return <RgbSliders />;
	}
	return (
		<>
			<Hue />
			<SaturationSlider />
			<ValueSlider />
		</>
	);
});

// ─── EyeDropper ─────────────────────────────────────────────────────────────

const EyeDropper = memo(function EyeDropper({
	className,
}: {
	className?: string;
}) {
	const { setHsva, hsva } = useColorPickerCtx();

	const supported = typeof window !== "undefined" && window.EyeDropper != null;

	const handleClick = useEventCallback(async () => {
		if (!window.EyeDropper) return;
		try {
			const dropper = new window.EyeDropper();
			const result = await dropper.open();
			const rgb = hexToRgb(result.sRGBHex);
			if (!rgb) return;
			const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
			setHsva({ h: s === 0 || v === 0 ? hsva.h : h, s, v, a: hsva.a });
		} catch {
			// User cancelled
		}
	});

	if (!supported) return null;

	return (
		<button
			type="button"
			className={twm(eyeDropperStyles(), className)}
			onClick={handleClick}
		>
			<Pipette className="size-4" />
		</button>
	);
});

// ─── Swatch ─────────────────────────────────────────────────────────────────

const Swatch = memo(function Swatch({ className }: { className?: string }) {
	const { hsva } = useColorPickerCtx();
	const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);

	return (
		<div
			className={twm(swatchStyles({ className }))}
			style={{ background: CHECKER_BG }}
		>
			<div
				className="size-full rounded-[inherit]"
				style={{
					backgroundColor: `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${hsva.a})`,
				}}
			/>
		</div>
	);
});

// ─── HexInput ───────────────────────────────────────────────────────────────

const HexInput = memo(function HexInput() {
	const { hsva, setHsva } = useColorPickerCtx();
	const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);
	const hex = rgbToHex(r, g, b);

	const [text, setText] = useState(hex);
	const [copied, setCopied] = useState(false);
	const internalChange = useRef(false);

	useEffect(() => {
		if (internalChange.current) {
			internalChange.current = false;
			return;
		}
		setText(hex);
	}, [hex]);

	const handleChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const val = e.target.value;
			setText(val);
			const parsed = hexToRgb(val);
			if (parsed) {
				internalChange.current = true;
				const [h, s, v] = rgbToHsv(parsed[0], parsed[1], parsed[2]);
				setHsva({ h: s === 0 || v === 0 ? hsva.h : h, s, v, a: hsva.a });
			}
		},
	);

	const handleBlur = useEventCallback(() => {
		setText(hex);
	});

	const handleCopy = useEventCallback(async () => {
		await navigator.clipboard.writeText(hex);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	});

	return (
		<div className="flex items-center gap-1">
			<input
				type="text"
				value={text}
				onChange={handleChange}
				onBlur={handleBlur}
				className={hexInputStyles()}
				spellCheck={false}
			/>
			<button
				type="button"
				onClick={handleCopy}
				className="inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
			>
				{copied ? (
					<Check className="size-3.5" />
				) : (
					<Copy className="size-3.5" />
				)}
			</button>
		</div>
	);
});

// ─── ModeToggle ─────────────────────────────────────────────────────────────

const ModeToggle = memo(function ModeToggle() {
	const { hsva, mode, onColorChange } = useColorPickerCtx();

	const handleChange = useEventCallback((value: string[]) => {
		const next = value[0];
		if (!next || next === mode) return;

		if (next === "hsva") {
			onColorChange({
				type: "hsv",
				h: hsva.h,
				s: hsva.s,
				v: hsva.v,
				a: hsva.a,
			});
		} else {
			const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);
			onColorChange({ type: "rgb", r, g, b, a: hsva.a });
		}
	});

	return (
		<ToggleGroup.Root value={[mode]} onValueChange={handleChange}>
			<ToggleGroup.Item value="hsva" className="h-5 w-auto px-1 text-[10px]">
				HSVA
			</ToggleGroup.Item>
			<ToggleGroup.Item value="rgba" className="h-5 w-auto px-1 text-[10px]">
				RGBA
			</ToggleGroup.Item>
		</ToggleGroup.Root>
	);
});

// ─── ChannelInputs ──────────────────────────────────────────────────────────

const ChannelInputs = memo(function ChannelInputs() {
	const { hsva, setHsva, mode, onColorChange } = useColorPickerCtx();

	const toggleMode = useEventCallback(() => {
		if (mode === "rgba") {
			onColorChange({
				type: "hsv",
				h: hsva.h,
				s: hsva.s,
				v: hsva.v,
				a: hsva.a,
			});
		} else {
			const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);
			onColorChange({ type: "rgb", r, g, b, a: hsva.a });
		}
	});

	const [r, g, b] = hsvToRgb(hsva.h, hsva.s, hsva.v);

	const handleRgbaChange = useEventCallback(
		(channel: "r" | "g" | "b" | "a", raw: string) => {
			const n = Number.parseFloat(raw);
			if (Number.isNaN(n)) return;

			if (channel === "a") {
				setHsva({ ...hsva, a: Math.min(1, Math.max(0, n / 100)) });
				return;
			}

			const nr = channel === "r" ? n / 255 : r;
			const ng = channel === "g" ? n / 255 : g;
			const nb = channel === "b" ? n / 255 : b;
			const clamped = [
				Math.min(1, Math.max(0, nr)),
				Math.min(1, Math.max(0, ng)),
				Math.min(1, Math.max(0, nb)),
			] as const;
			const [h, s, v] = rgbToHsv(clamped[0], clamped[1], clamped[2]);
			setHsva({
				h: s === 0 || v === 0 ? hsva.h : h,
				s,
				v,
				a: hsva.a,
			});
		},
	);

	const handleHsvaChange = useEventCallback(
		(channel: "h" | "s" | "v" | "a", raw: string) => {
			const n = Number.parseFloat(raw);
			if (Number.isNaN(n)) return;

			if (channel === "a") {
				setHsva({ ...hsva, a: Math.min(1, Math.max(0, n / 100)) });
				return;
			}

			const nh = channel === "h" ? n / 360 : hsva.h;
			const ns = channel === "s" ? n / 100 : hsva.s;
			const nv = channel === "v" ? n / 100 : hsva.v;
			setHsva({
				h: Math.min(1, Math.max(0, nh)),
				s: Math.min(1, Math.max(0, ns)),
				v: Math.min(1, Math.max(0, nv)),
				a: hsva.a,
			});
		},
	);

	const styles = channelInputStyles();

	if (mode === "hsva") {
		const displayH = Math.round(hsva.h * 360);
		const displayS = Math.round(hsva.s * 100);
		const displayV = Math.round(hsva.v * 100);
		const displayA = Math.round(hsva.a * 100);

		return (
			<div className="flex items-end gap-1 px-3 pb-3">
				<button
					type="button"
					onClick={toggleMode}
					className={styles.modeButton()}
				>
					HSVA
				</button>
				<div className="flex flex-1 justify-center gap-1">
					{[
						["H", displayH, 0, 360, 1, "h"] as const,
						["S", displayS, 0, 100, 1, "s"] as const,
						["V", displayV, 0, 100, 1, "v"] as const,
						["A", displayA, 0, 100, 1, "a"] as const,
					].map(([label, value, min, max, step, ch]) => (
						<div key={label} className="flex flex-col items-center gap-0.5">
							<input
								type="number"
								value={value}
								min={min}
								max={max}
								step={step}
								onChange={(e) => handleHsvaChange(ch, e.target.value)}
								className={styles.input()}
							/>
							<span className={styles.label()}>{label}</span>
						</div>
					))}
				</div>
			</div>
		);
	}

	const displayR = Math.round(r * 255);
	const displayG = Math.round(g * 255);
	const displayB = Math.round(b * 255);
	const displayA = Math.round(hsva.a * 100);

	return (
		<div className="flex items-end gap-1 px-3 pb-3">
			<button
				type="button"
				onClick={toggleMode}
				className={styles.modeButton()}
			>
				RGBA
			</button>
			<div className="flex flex-1 justify-center gap-1">
				{[
					["R", displayR, 0, 255, 1, "r"] as const,
					["G", displayG, 0, 255, 1, "g"] as const,
					["B", displayB, 0, 255, 1, "b"] as const,
					["A", displayA, 0, 100, 1, "a"] as const,
				].map(([label, value, min, max, step, ch]) => (
					<div key={label} className="flex flex-col items-center gap-0.5">
						<input
							type="number"
							value={value}
							min={min}
							max={max}
							step={step}
							onChange={(e) => handleRgbaChange(ch, e.target.value)}
							className={styles.input()}
						/>
						<span className={styles.label()}>{label}</span>
					</div>
				))}
			</div>
		</div>
	);
});

// ─── Compound export ────────────────────────────────────────────────────────

export const ColorPicker2 = {
	Root,
	Saturation,
	Hue,
	Alpha,
	SaturationSlider,
	ValueSlider,
	RgbSliders,
	ModeSliders,
	ModeToggle,
	EyeDropper,
	Swatch,
	HexInput,
	ChannelInputs,
};

// ─── Convenience wrappers ───────────────────────────────────────────────────

export const ColorPickerThin = memo(function ColorPickerThin({
	color,
	onColorChange,
}: {
	color: Color;
	onColorChange: (color: Color) => void;
}) {
	return (
		<ColorPicker2.Root color={color} onColorChange={onColorChange}>
			<div className="flex gap-2 items-start">
				<div className="flex flex-col items-center gap-1 shrink-0">
					<ColorPicker2.Swatch className="size-8" />
				</div>
				<div className="flex flex-1 flex-col gap-1 -mt-1">
					<ColorPicker2.ModeSliders />
					<ColorPicker2.Alpha />
					<div className="flex items-center justify-between">
						<ColorPicker2.ModeToggle />
						<ColorPicker2.HexInput />
					</div>
				</div>
			</div>
		</ColorPicker2.Root>
	);
});

export const ColorPickerFull = memo(function ColorPickerFull({
	color,
	onColorChange,
	saturationHeight,
	className,
}: {
	color: Color;
	onColorChange: (color: Color) => void;
	saturationHeight?: string;
	className?: string;
}) {
	return (
		<ColorPicker2.Root color={color} onColorChange={onColorChange}>
			<div className={twm("flex flex-col rounded-lg bg-popover", className)}>
				<ColorPicker2.Saturation className={saturationHeight} />
				<div className="flex items-start gap-3 p-3">
					<div className="flex flex-col items-center gap-1 shrink-0">
						<ColorPicker2.Swatch className="size-8" />
						<ColorPicker2.EyeDropper />
					</div>
					<div className="flex flex-1 flex-col gap-2">
						<ColorPicker2.ModeSliders />
						<ColorPicker2.Alpha />
						<div className="flex items-center justify-between">
							<ColorPicker2.ModeToggle />
							<ColorPicker2.HexInput />
						</div>
					</div>
				</div>
			</div>
		</ColorPicker2.Root>
	);
});

// ─── Color conversion helpers ───────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [r: number, g: number, b: number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}
