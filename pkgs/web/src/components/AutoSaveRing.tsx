import { memo, useEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useTranslation } from "@/locales";
import {
	autoSaveState,
	computeRingProgress,
	formatAutoSaveCountdown,
} from "@/stores/autoSave";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { Tooltip } from "./Tooltip";

const RING_SIZE = 20;
const RING_RADIUS = 8;
const RING_STROKE = 2;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const HOLD_FULL_MS = 5_000;

export const AutoSaveRing = memo(function AutoSaveRing() {
	const t = useTranslation();
	const { save } = useAutoSave();
	const snap = useSnapshot(autoSaveState);
	const progressCircleRef = useRef<SVGCircleElement>(null);
	const rafRef = useRef<number>(0);
	const [justSaved, setJustSaved] = useState(false);
	const prevSaveCountRef = useRef(snap.saveCount);

	useEffect(() => {
		if (snap.saveCount > prevSaveCountRef.current) {
			setJustSaved(true);
			const timeout = setTimeout(() => setJustSaved(false), HOLD_FULL_MS);
			prevSaveCountRef.current = snap.saveCount;
			return () => clearTimeout(timeout);
		}
	}, [snap.saveCount]);

	useEffect(() => {
		const animate = () => {
			const { lastSaveTimestamp, intervalMs, isSaving } = autoSaveState;
			const now = Date.now();
			const sinceSave = now - lastSaveTimestamp;

			if (progressCircleRef.current && !isSaving) {
				const progress =
					sinceSave < HOLD_FULL_MS
						? 1
						: computeRingProgress(lastSaveTimestamp, intervalMs, now);
				const offset = CIRCUMFERENCE * (1 - progress);
				progressCircleRef.current.style.strokeDashoffset = String(offset);
			}

			rafRef.current = requestAnimationFrame(animate);
		};

		rafRef.current = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(rafRef.current);
	}, []);

	const [countdown, setCountdown] = useState(() =>
		formatAutoSaveCountdown(autoSaveState.nextSaveAt - Date.now()),
	);

	useEffect(() => {
		const id = setInterval(() => {
			setCountdown(
				formatAutoSaveCountdown(autoSaveState.nextSaveAt - Date.now()),
			);
		}, 1_000);
		return () => clearInterval(id);
	}, []);

	const handleClick = useEventCallback(() => {
		save();
	});

	const statusText = snap.isSlowDocument
		? t("autoSave.slowDocumentTooltip")
		: t("autoSave.nextSaveIn", { time: countdown });

	const tooltipContent = (
		<>
			<div>{statusText}</div>
			<div className="opacity-60">{t("autoSave.clickToSave")}</div>
		</>
	);

	return (
		<Tooltip content={tooltipContent} side="bottom">
			<button
				type="button"
				onClick={handleClick}
				className="flex items-center justify-center w-6 h-6 rounded hover:bg-foreground/10 transition-colors cursor-pointer"
			>
				<svg
					role="img"
					aria-label="Auto-save progress"
					width={RING_SIZE}
					height={RING_SIZE}
					className={twm(
						"transition-[color] duration-500",
						justSaved && "text-success",
						snap.isSaving && "animate-spin",
					)}
				>
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_RADIUS}
						fill="none"
						stroke="currentColor"
						strokeWidth={RING_STROKE}
						opacity={0.15}
					/>
					<circle
						ref={progressCircleRef}
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_RADIUS}
						fill="none"
						stroke="currentColor"
						strokeWidth={RING_STROKE}
						strokeDasharray={CIRCUMFERENCE}
						strokeDashoffset={CIRCUMFERENCE}
						strokeLinecap="round"
						transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
					/>
				</svg>
			</button>
		</Tooltip>
	);
});
