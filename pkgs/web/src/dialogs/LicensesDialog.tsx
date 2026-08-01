import { ArrowLeft, ExternalLink as ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { createCallable } from "react-call";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { ExternalLink } from "@/components/ExternalLink";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { DEPENDENCY_LICENSES } from "./dependencyLicenses.generated";
import { ALGORITHM_REFERENCES, BUNDLED_LICENSES } from "./thirdPartyLicenses";

/**
 * Shows the attribution Paplico owes to third parties: license texts for the
 * assets and code we ship, and credit for the work we only reimplemented.
 */
export const LicensesDialog = createCallable<void, void>(({ call }) => {
	const t = useTranslation();
	const [dependenciesOpen, setDependenciesOpen] = useState(false);

	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) call.end();
	});
	const handleClose = useEventCallback(() => call.end());
	const handleOpenDependencies = useEventCallback(() =>
		setDependenciesOpen(true),
	);
	const handleCloseDependencies = useEventCallback(() =>
		setDependenciesOpen(false),
	);

	return (
		<Dialog.Root open onOpenChange={handleOpenChange}>
			<Dialog.Content className="w-[680px] overflow-hidden">
				<Dialog.Title className="font-bold">{t("licenses.title")}</Dialog.Title>
				<Dialog.Description>{t("licenses.description")}</Dialog.Description>

				<div className="max-h-[60vh] overflow-y-auto pr-2 flex flex-col gap-8">
					<section>
						<h3 className="text-sm font-bold text-foreground mb-1">
							{t("licenses.bundledSection")}
						</h3>
						<p className="text-xs text-muted-foreground mb-4">
							{t("licenses.bundledSectionNote")}
						</p>

						<div className="flex flex-col gap-6">
							{BUNDLED_LICENSES.map((license) => (
								<details key={license.name}>
									<summary className="cursor-pointer select-none marker:text-muted-foreground">
										<h4 className="inline text-sm font-semibold text-foreground">
											{license.name}
										</h4>
										<ExternalLink
											href={license.url}
											aria-label={t("licenses.openLink")}
											className="inline-flex align-middle ml-1.5 text-muted-foreground hover:text-foreground"
										>
											<ExternalLinkIcon size={13} />
										</ExternalLink>
										<span className="block text-xs text-muted-foreground mt-0.5">
											{license.license} — {license.used}
										</span>
									</summary>
									<pre className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed border-l-2 border-border/60 pl-3">
										{license.body}
									</pre>
								</details>
							))}
						</div>
					</section>

					<section>
						<h3 className="text-sm font-bold text-foreground mb-1">
							{t("licenses.referencesSection")}
						</h3>
						<p className="text-xs text-muted-foreground mb-4">
							{t("licenses.referencesSectionNote")}
						</p>

						<div className="flex flex-col gap-4">
							{ALGORITHM_REFERENCES.map((reference) => (
								<article key={reference.name}>
									<h4 className="inline text-sm font-semibold text-foreground">
										{reference.name}
									</h4>
									<ExternalLink
										href={reference.url}
										aria-label={t("licenses.openLink")}
										className="inline-flex align-middle ml-1.5 text-muted-foreground hover:text-foreground"
									>
										<ExternalLinkIcon size={13} />
									</ExternalLink>
									<p className="text-xs text-muted-foreground mt-0.5">
										{reference.license} — {reference.used}
									</p>
								</article>
							))}
						</div>
					</section>
				</div>

				<div className="flex justify-center mt-5">
					<button
						type="button"
						onClick={handleOpenDependencies}
						className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-dotted outline-none"
					>
						{t("licenses.detailsLink")}
					</button>
				</div>

				<div className="flex items-center justify-end mt-4">
					<Button $variant="default" $size="sm" onClick={handleClose}>
						{t("common.ok")}
					</Button>
				</div>

				{dependenciesOpen && (
					<DependencyPanel onBack={handleCloseDependencies} />
				)}
			</Dialog.Content>
		</Dialog.Root>
	);
});

const MASK_TEETH = 36;
const MASK_DRAW_SECONDS = 1;

/** Distinguishes each panel mount's mask image so its animation replays. */
let maskInstanceCounter = 0;

/**
 * The dependency list, packed left to right so seventy names read as a body of
 * text rather than a ledger. Each entry is masked by a fine zigzag line that
 * covers it and draws itself from start to end, revealing what the line has
 * passed. Safari cannot reference an inline SVG <mask> element from HTML
 * content, so the line lives in a standalone SVG image (data URI) whose SMIL
 * animation slides the dash offset — animation included, that path works
 * everywhere.
 */
function DependencyPanel({ onBack }: { onBack: () => void }) {
	const t = useTranslation();
	// A fresh URI per mount: reusing one would replay nothing on reopen, since
	// the cached image's animation has already run to its end.
	const [maskStyle] = useState(() => ({
		maskImage: `url("data:image/svg+xml,${encodeURIComponent(
			buildJaggedLineMaskSvg(++maskInstanceCounter),
		)}")`,
		maskRepeat: "no-repeat",
		maskSize: "100% 100%",
	}));

	return (
		<div className="absolute inset-0 z-10 flex flex-col bg-background p-6">
			<div className="flex items-center gap-2 mb-1">
				<Button $variant="ghost" $size="icon" onClick={onBack}>
					<ArrowLeft size={16} />
				</Button>
				<h3 className="text-sm font-bold text-foreground">
					{t("licenses.dependenciesSection")}
				</h3>
			</div>
			<p className="text-xs text-muted-foreground mb-4 pl-12">
				{t("licenses.dependenciesSectionNote")}
			</p>

			<div className="flex-1 overflow-y-auto pr-2">
				<div className="flex flex-wrap content-start gap-x-4 gap-y-1.5">
					{DEPENDENCY_LICENSES.map((dependency) => (
						<ExternalLink
							key={dependency.name}
							href={dependency.url}
							className="text-xs whitespace-nowrap hover:underline underline-offset-4"
							style={maskStyle}
						>
							<span className="font-semibold text-foreground">
								{dependency.name}
							</span>
							<span className="text-muted-foreground">
								{" "}
								{dependency.version} · {dependency.license}
							</span>
						</ExternalLink>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * A fine zigzag line covering the whole 360x100 box, its tips overshooting the
 * edges so the stroke leaves no uncovered notches. With pathLength pinned to 1
 * and the dash offset animated 1 -> 0, the stroke draws itself left to right
 * over MASK_DRAW_SECONDS. preserveAspectRatio=none stretches pitch and stroke
 * width together, so coverage holds at any element size.
 */
function buildJaggedLineMaskSvg(instance: number): string {
	const segments = ["M0 105"];
	for (let i = 1; i <= MASK_TEETH * 2; i++) {
		segments.push(`L${i * 5} ${i % 2 === 1 ? -5 : 105}`);
	}

	return (
		`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${MASK_TEETH * 10} 100' preserveAspectRatio='none' data-instance='${instance}'>` +
		`<path d='${segments.join(" ")}' pathLength='1' fill='none' stroke='white' stroke-width='13' stroke-dasharray='1' stroke-dashoffset='1'>` +
		`<animate attributeName='stroke-dashoffset' from='1' to='0' dur='${MASK_DRAW_SECONDS}s' calcMode='spline' keyTimes='0;1' keySplines='0.33 1 0.68 1' fill='freeze'/>` +
		`</path></svg>`
	);
}
