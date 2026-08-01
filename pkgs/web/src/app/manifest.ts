import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Paplico",
		short_name: "Paplico",
		description: "Infinite canvas drawing application",
		start_url: "/",
		display: "fullscreen",
		orientation: "any",
		background_color: "#1e293b",
		theme_color: "#1e293b",
		icons: [
			{
				src: "/icon-192.png",
				sizes: "192x192",
				type: "image/png",
			},
			{
				src: "/icon-512.png",
				sizes: "512x512",
				type: "image/png",
			},
		],
	};
}
