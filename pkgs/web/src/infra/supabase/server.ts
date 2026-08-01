import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client using the service role key.
 * Bypasses RLS — always verify user identity before performing operations.
 */
export function createServiceClient() {
	const url = process.env.SUPABASE_INTERNAL_URL ?? process.env.SUPABASE_URL;
	const secretKey = process.env.SUPABASE_SECRET_KEY;

	if (!url) {
		throw new Error(
			"Missing SUPABASE_URL or SUPABASE_INTERNAL_URL environment variable",
		);
	}
	if (!secretKey) {
		throw new Error("Missing SUPABASE_SECRET_KEY environment variable");
	}

	return createClient(url, secretKey, { auth: { persistSession: false } });
}

/**
 * Verify a Supabase JWT and return the user.
 * Use this in API routes to authenticate requests.
 */
export async function verifyAuthToken(authHeader: string | null) {
	if (!authHeader?.startsWith("Bearer ")) return null;

	const token = authHeader.slice(7);
	const client = createServiceClient();
	const {
		data: { user },
		error,
	} = await client.auth.getUser(token);

	if (error || !user) return null;
	return user;
}
