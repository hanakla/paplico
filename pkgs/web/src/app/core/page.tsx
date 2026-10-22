import {
	ArrowRight,
	Brush,
	Cpu,
	FileOutput,
	Github,
	History,
	Palette,
	PenTool,
	Sparkles,
	Users,
} from "lucide-react";
import Link from "next/link";
import { Bubbles } from "./_components/Bubbles";
import { Code } from "./_components/Code";
import { CopyInstall } from "./_components/CopyInstall";
import { CollabDemo } from "./_components/demos/CollabDemo";
import { FilterDemo } from "./_components/demos/FilterDemo";
import { HeroDemo } from "./_components/demos/HeroDemo";
import { SiteHeader } from "./_components/SiteHeader";
import { GITHUB_URL } from "./links";

const FEATURES = [
	{
		icon: Brush,
		title: "Brushes that feel like paint",
		body: "Dab, ribbon and geometric engines with wet mixing. Pressure, tilt, speed and stabilization drive every property.",
	},
	{
		icon: PenTool,
		title: "Vector at heart",
		body: "Every stroke is an editable path. Groups, compound paths, OpenType text, mesh warps, blends and repeats come built in.",
	},
	{
		icon: Sparkles,
		title: "60+ GPU filters",
		body: "Shadows, bloom, halftone, glitch, 3D extrusion and the SVG filter set. Stack them per element and edit them any time.",
	},
	{
		icon: Users,
		title: "Collaboration on Yjs",
		body: "Documents are CRDTs. Plug in the WebSocket, PartyKit or end-to-end encrypted transport, or write your own.",
	},
	{
		icon: History,
		title: "Undo that just works",
		body: "Every edit goes through one command layer, so undo, redo and remote edits never step on each other.",
	},
	{
		icon: FileOutput,
		title: "Export to what people use",
		body: "PNG, JPEG, 10-bit HDR AVIF, layered PSD, CMYK TIFF and SVG. Save and load the native papf format in one call.",
	},
	{
		icon: Palette,
		title: "Color you can trust",
		body: "ICC profiles, Display P3 working space, HDR documents and soft proofing against a print profile.",
	},
	{
		icon: Cpu,
		title: "No framework attached",
		body: "Plain TypeScript over a canvas. State lives in Valtio proxies you can read from React, Vue, Svelte or nothing at all.",
	},
];

const FILTER_SNIPPET = `
import type { DropShadowFilter } from "@paplico/core/filters";
import { generateUid } from "@paplico/core/schema";

const shadow: DropShadowFilter = {
  uid: generateUid("filter"),
  processor: "drop-shadow",
  opacity: 1,
  blendMode: "normal",
  paramData: {
    version: "1",
    params: { offsetX: 4, offsetY: -4, blurRadius: 8 },
  },
};

// Filters live on the element, so they stay editable
paplico.commands.updateElement(layerId, element.id, {
  filters: [...(element.filters ?? []), shadow],
});
`;

const COLLAB_SNIPPET = `
import { PartyKitCollaboration } from "@paplico/core/collaboration";

paplico.connectCollaboration(
  (ydoc) => new PartyKitCollaboration(ydoc, { roomId, relayHost }),
  { document: "keepForRemote" },
);
`;

const QUICKSTART = [
	{
		step: "Install",
		code: "npm install @paplico/core",
		lang: "bash",
	},
	{
		step: "Create",
		code: `
import { Paplico } from "@paplico/core";

const paplico = await Paplico.create(canvas, {
  fontLoaders: [],
  // Reads the ICC profiles your app serves
  getBuiltinProfileBytes,
});
paplico.startRendering();`,
		lang: "ts",
	},
	{
		step: "Draw & save",
		code: `
paplico.tools.setCurrentTool("pen");

// Later: one call to a papf Blob
const blob = await paplico.exportDocument();`,
		lang: "ts",
	},
];

export default function CoreLandingPage() {
	return (
		<div className="aero-sky fixed inset-0 overflow-x-hidden overflow-y-auto">
			<SiteHeader />

			{/* Hero */}
			<section className="relative isolate px-6 pt-10 pb-20">
				<div className="aero-aurora -z-10" />
				<Bubbles />
				<div className="relative mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1fr_1.25fr]">
					<div>
						<span className="aero-glass inline-block rounded-full! px-3 py-1 text-xs font-semibold text-sky-800">
							WebGPU · TypeScript · v0.9
						</span>
						<h1 className="mt-5 text-4xl leading-tight font-bold tracking-tight text-balance sm:text-5xl">
							<span className="aero-gloss-text">
								Put a real painting engine
							</span>{" "}
							in your web app.
						</h1>
						<p className="mt-5 max-w-xl text-lg leading-relaxed text-sky-950/80">
							@paplico/core is the engine behind the Paplico app. Brushes,
							vector paths, GPU filters and live collaboration, in a typed
							package you embed in your own UI.
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<Link
								href="/core/docs/getting-started"
								className="aero-button"
								data-variant="lime"
							>
								Get started <ArrowRight className="size-4" />
							</Link>
							<a href={GITHUB_URL} className="aero-button" data-variant="glass">
								<Github className="size-4" /> GitHub
							</a>
						</div>
						<div className="mt-6">
							<CopyInstall />
						</div>
					</div>
					<HeroDemo />
				</div>
			</section>

			{/* Features */}
			<section id="features" className="px-6 py-20">
				<div className="mx-auto max-w-6xl">
					<SectionHeading
						eyebrow="What you get"
						title="Everything a drawing app needs, below the UI."
						lead="Paplico Core owns the document, the GPU and the input. You own the buttons, panels and the rest of your product."
					/>
					<div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
						{FEATURES.map((feature) => (
							<article key={feature.title} className="aero-glass p-5">
								<span className="grid size-10 place-items-center rounded-xl bg-linear-to-b from-sky-300 to-sky-600 text-white shadow-inner">
									<feature.icon className="size-5" />
								</span>
								<h3 className="mt-4 font-semibold">{feature.title}</h3>
								<p className="mt-2 text-sm leading-relaxed text-sky-950/75">
									{feature.body}
								</p>
							</article>
						))}
					</div>
				</div>
			</section>

			{/* Filter demo */}
			<section id="filters" className="relative px-6 py-20">
				<div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1fr_1.4fr]">
					{/* min-w-0 lets the code panel scroll instead of widening the column */}
					<div className="min-w-0">
						<SectionHeading
							eyebrow="Live demo · Filters"
							title="Stack effects. Change your mind later."
							lead="Each element keeps its own filter stack, rendered on the GPU every frame. Nothing is baked into pixels, so every effect stays adjustable and removable."
							align="left"
						/>
						<Code code={FILTER_SNIPPET} title="Add filters to an element" />
					</div>
					<FilterDemo />
				</div>
			</section>

			{/* Collaboration demo */}
			<section id="collaboration" className="relative px-6 py-20">
				<Bubbles />
				<div className="relative mx-auto max-w-6xl">
					<SectionHeading
						eyebrow="Live demo · Collaboration"
						title="Two canvases. One document."
						lead="Both windows below run their own engine. They share one Yjs document through a small transport built on BroadcastChannel. Open this page in a second tab and it joins in too."
					/>
					<div className="mt-10">
						<CollabDemo />
					</div>
					<div className="mx-auto mt-8 max-w-2xl">
						<Code code={COLLAB_SNIPPET} title="Connect to a PartyKit room" />
						<p className="text-center text-sm text-sky-950/70">
							Read how the demo transport works in the{" "}
							<Link
								href="/core/docs/collaboration"
								className="font-semibold text-sky-700 underline"
							>
								collaboration guide
							</Link>
							.
						</p>
					</div>
				</div>
			</section>

			{/* Quickstart */}
			<section id="quickstart" className="px-6 py-20">
				<div className="mx-auto max-w-6xl">
					<SectionHeading
						eyebrow="Quickstart"
						title="From npm install to the first stroke."
						lead="Hand the engine a canvas and the files it cannot fetch by itself. It takes over pointer input, rendering and the document from there."
					/>
					<ol className="mt-12 grid gap-5 lg:grid-cols-3">
						{QUICKSTART.map((item, index) => (
							<li key={item.step} className="aero-glass min-w-0 p-5">
								<span className="flex items-center gap-3 font-semibold">
									<span className="grid size-8 place-items-center rounded-full bg-linear-to-b from-lime-300 to-lime-600 text-sm text-white shadow-inner">
										{index + 1}
									</span>
									{item.step}
								</span>
								<Code code={item.code} lang={item.lang} />
							</li>
						))}
					</ol>
					<p className="mt-8 text-center">
						<Link
							href="/core/docs/getting-started"
							className="aero-button"
							data-variant="lime"
						>
							Read the full guide <ArrowRight className="size-4" />
						</Link>
					</p>
				</div>
			</section>

			{/* Fine print */}
			<section id="requirements" className="px-6 py-20">
				<div className="aero-glass mx-auto grid max-w-4xl gap-8 p-8 sm:grid-cols-3">
					<FinePrint title="WebGPU only">
						There is no Canvas 2D or WebGL fallback. Visitors need a browser
						with WebGPU.
					</FinePrint>
					<FinePrint title="You serve a few files">
						ICC profiles and a fallback font come from your app, so the engine
						never fetches anything on its own.
					</FinePrint>
					<FinePrint title="AGPL-3.0-or-later">
						Shipping it inside a product, including a hosted service, means
						sharing that product’s source under the same license.
					</FinePrint>
				</div>
			</section>

			<footer className="px-6 pt-10 pb-16 text-center">
				<h2 className="text-3xl font-bold">
					<span className="aero-gloss-text">Start drawing in minutes.</span>
				</h2>
				<div className="mt-6 flex flex-wrap justify-center gap-3">
					<Link
						href="/core/docs/getting-started"
						className="aero-button"
						data-variant="lime"
					>
						Get started <ArrowRight className="size-4" />
					</Link>
					<Link href="/" className="aero-button" data-variant="glass">
						Open the Paplico app
					</Link>
				</div>
			</footer>
		</div>
	);
}

function SectionHeading({
	eyebrow,
	title,
	lead,
	align = "center",
}: {
	eyebrow: string;
	title: string;
	lead: string;
	align?: "center" | "left";
}) {
	return (
		<div
			className={
				align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl"
			}
		>
			<p className="text-sm font-semibold tracking-wide text-sky-600 uppercase">
				{eyebrow}
			</p>
			<h2 className="mt-2 text-3xl font-bold tracking-tight text-balance">
				{title}
			</h2>
			<p className="mt-4 leading-relaxed text-sky-950/75">{lead}</p>
		</div>
	);
}

function FinePrint({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<h3 className="font-semibold">{title}</h3>
			<p className="mt-2 text-sm leading-relaxed text-sky-950/75">{children}</p>
		</div>
	);
}
