import type { AnyArtObject } from "@paplico/core/schema";
import { getFirstFill, getFirstStroke } from "@paplico/core/utils";
import { useEffect, useState } from "react";
import { useSnapshot } from "valtio";
import { ColorSwatch } from "@/components/ColorSwatch";
import { usePaplico, usePaplicoStore } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { getElementTypeLabel } from "@/organisms/LayerPanel";
import { twm } from "@/utils/tailwind";

/**
 * Elements painted under an eyedropper long press or right click, front to
 * back. Choosing one copies its appearance, as a plain eyedropper click
 * would for the frontmost.
 */
export function EyedropperCandidateActions({
	candidates,
}: {
	candidates: readonly { elementId: string; depth: number }[];
}) {
	const t = useTranslation();
	const paplico = usePaplico();
	const snap = useSnapshot(usePaplicoStore());
	const [pressedOverId, setPressedOverId] = useState<string | null>(null);

	// The list opens while the press that opened it is still held, so that
	// press can be dragged onto a row and released to choose it. The canvas
	// holds the pointer capture meanwhile, hence the window listeners and the
	// lookup by position.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new candidate list comes from a new press, whose release must be listened for again
	useEffect(() => {
		const rowIdAt = (e: PointerEvent) =>
			document
				.elementFromPoint(e.clientX, e.clientY)
				?.closest<HTMLElement>("[data-eyedropper-candidate-id]")?.dataset
				.eyedropperCandidateId ?? null;

		const handleMove = (e: PointerEvent) => {
			setPressedOverId(rowIdAt(e));
		};
		const handleUp = (e: PointerEvent) => {
			window.removeEventListener("pointermove", handleMove, { capture: true });
			setPressedOverId(null);
			const id = rowIdAt(e);
			if (id) paplico.eyedropperPickCandidate(id);
		};

		window.addEventListener("pointermove", handleMove, { capture: true });
		window.addEventListener("pointerup", handleUp, {
			capture: true,
			once: true,
		});
		return () => {
			window.removeEventListener("pointermove", handleMove, { capture: true });
			window.removeEventListener("pointerup", handleUp, { capture: true });
		};
	}, [paplico, candidates]);

	return (
		<div className="flex min-w-40 flex-col py-0.5">
			{candidates.map(({ elementId, depth }) => {
				const element = snap.document.objects[elementId] as
					| AnyArtObject
					| undefined;
				if (!element) return null;

				return (
					<button
						key={elementId}
						type="button"
						data-eyedropper-candidate-id={elementId}
						className={twm(
							"flex cursor-default items-center gap-2 rounded py-1 pr-3 text-sm text-foreground select-none hover:bg-muted-hover",
							pressedOverId === elementId && "bg-muted",
						)}
						style={{ paddingLeft: 8 + depth * 16 }}
						onClick={() => paplico.eyedropperPickCandidate(elementId)}
					>
						<AppearanceSwatch element={element} />
						{element.name || getElementTypeLabel(element, t)}
					</button>
				);
			})}
		</div>
	);
}

/** Fill in the back corner, stroke in the front corner, as in the toolbar swatch. */
function AppearanceSwatch({ element }: { element: AnyArtObject }) {
	return (
		<span className="relative size-5.5 flex-none">
			<ColorSwatch
				color={getFirstFill(element.filters)?.paramData.params.fill ?? null}
				variant="fill"
				size={15}
				className="absolute top-0 left-0 ring-1 ring-border"
			/>
			<ColorSwatch
				color={
					getFirstStroke(element.filters)?.paramData.params.strokeColor ?? null
				}
				variant="stroke"
				size={15}
				className="absolute right-0 bottom-0 ring-1 ring-border"
			/>
		</span>
	);
}
