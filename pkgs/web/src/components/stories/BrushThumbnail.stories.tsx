import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { EmbeddedFile } from "@/core/schema";
import { BrushThumbnail } from "@/organisms/Toolbar/BrushTools";

function createSvgTexture({
	uid,
	name,
	color,
	patternColor,
}: {
	uid: string;
	name: string;
	color: string;
	patternColor: string;
}): EmbeddedFile {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
<rect width="32" height="32" fill="${color}" />
<path d="M0 0L32 32M32 0L0 32" stroke="${patternColor}" stroke-width="2" />
</svg>`;

	return {
		uid,
		name,
		type: "image/svg+xml",
		hash: `hash-${uid}`,
		bin: new TextEncoder().encode(svg),
	};
}

const textures = [
	undefined,
	createSvgTexture({
		uid: "brush-1",
		name: "Cross Blue",
		color: "#67e8f9",
		patternColor: "#0f172a",
	}),
	createSvgTexture({
		uid: "brush-2",
		name: "Cross Orange",
		color: "#fdba74",
		patternColor: "#7c2d12",
	}),
] as const;

const sizes = [20, 28, 40, 56] as const;

const meta = {
	title: "Components/BrushThumbnail",
	component: BrushThumbnail,
} satisfies Meta<typeof BrushThumbnail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	args: {} as any,
	render: () => (
		<div className="grid gap-3 md:grid-cols-3">
			{textures.map((texture, textureIndex) => (
				<div
					key={texture?.uid ?? `empty-${textureIndex}`}
					className="space-y-3 rounded-md border border-border p-3"
				>
					<p className="text-xs text-muted-foreground">
						{texture?.name ?? "undefined file"}
					</p>
					<div className="flex flex-wrap items-center gap-3">
						{sizes.map((size) => (
							<div
								key={`${texture?.uid ?? "empty"}-${size}`}
								className="space-y-1"
							>
								<BrushThumbnail file={texture} size={size} />
								<p className="text-[10px] text-muted-foreground">{size}px</p>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	),
};
