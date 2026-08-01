import { createClient } from "@supabase/supabase-js";
import { prettifyError, z } from "zod";
import { apiHandler } from "@/utils/nextjs";

const querySchema = z.object({
	provider: z.enum(["x", "discord"]),
	callback: z.string().optional(),
	port: z.string().optional(),
	state: z.string().optional(),
});

export const { GET, dynamic } = apiHandler({}, async (request) => {
	const { searchParams, origin } = request.nextUrl;

	const parsed = querySchema.safeParse({
		provider: searchParams.get("provider") ?? undefined,
		callback: searchParams.get("callback") ?? undefined,
		port: searchParams.get("port") ?? undefined,
		state: searchParams.get("state") ?? undefined,
	});

	if (!parsed.success) {
		return Response.json(
			{ error: "Validation failed", details: prettifyError(parsed.error) },
			{ status: 400 },
		);
	}

	const { provider, callback, port, state } = parsed.data;

	const supabaseUrl = process.env.SUPABASE_URL;
	const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

	if (!supabaseUrl || !supabaseKey) {
		return Response.json(
			{ error: "Supabase environment variables are not configured" },
			{ status: 500 },
		);
	}

	const supabase = createClient(supabaseUrl, supabaseKey);

	const encodedState = btoa(
		JSON.stringify({ tauriState: state, callback, port }),
	);

	const { data, error } = await supabase.auth.signInWithOAuth({
		provider,
		options: {
			skipBrowserRedirect: true,
			redirectTo:
				callback === "popup"
					? `${origin}/auth/sso-callback`
					: `${origin}/auth/app/callback`,
			queryParams: { tauri_state: encodedState },
		},
	});

	if (error || !data.url) {
		return Response.json(
			{ error: error?.message ?? "Failed to initiate OAuth" },
			{ status: 500 },
		);
	}

	if (callback === "popup") {
		return Response.json({ url: data.url });
	}

	return Response.redirect(data.url);
});
