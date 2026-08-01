import { prettifyError, z } from "zod";
import { createServiceClient } from "@/infra/supabase/server";
import { apiHandler } from "@/utils/nextjs";

const ALLOWED_AVATAR_HOSTS = new Set([
	"pbs.twimg.com",
	"cdn.discordapp.com",
	"avatars.githubusercontent.com",
]);

const paramsSchema = z.object({
	uuid: z.uuid(),
});

export const { GET, dynamic } = apiHandler<z.infer<typeof paramsSchema>>(
	{},
	async (_request, { params }) => {
		const parsed = paramsSchema.safeParse(await params);
		if (!parsed.success) {
			return Response.json(
				{ error: prettifyError(parsed.error) },
				{ status: 400 },
			);
		}

		const { uuid } = parsed.data;
		const supabase = createServiceClient();
		const {
			data: { user },
			error,
		} = await supabase.auth.admin.getUserById(uuid);

		if (error || !user) {
			return new Response(null, { status: 404 });
		}

		const avatarUrl = user.user_metadata?.avatar_url as string | undefined;
		if (!avatarUrl) {
			return new Response(null, { status: 404 });
		}

		let parsedUrl: URL;
		try {
			parsedUrl = new URL(avatarUrl);
		} catch {
			return new Response(null, { status: 403 });
		}

		if (
			parsedUrl.protocol !== "https:" ||
			!ALLOWED_AVATAR_HOSTS.has(parsedUrl.hostname)
		) {
			return new Response(null, { status: 403 });
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		try {
			const res = await fetch(avatarUrl, { signal: controller.signal });
			if (!res.ok) {
				return new Response(null, { status: 502 });
			}

			return new Response(res.body, {
				headers: {
					"Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
					"Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
				},
			});
		} catch {
			return new Response(null, { status: 502 });
		} finally {
			clearTimeout(timeout);
		}
	},
);
