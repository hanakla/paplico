import { z } from "zod";
import { createServiceClient, verifyAuthToken } from "@/infra/supabase/server";
import { apiHandler } from "@/utils/nextjs";
import { signRoomId } from "../collaboration/rooms/roomToken";

const isCloudMode = process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud";

// Simple in-memory rate limiter (per-IP, resets on server restart)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (entry && now >= entry.resetAt) {
		rateLimitMap.delete(ip);
	}

	if (entry && now < entry.resetAt) {
		if (entry.count >= RATE_LIMIT) return false;
		entry.count++;
	} else {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
	}

	return true;
}

export const dynamic = "force-dynamic";

export const { POST } = apiHandler({}, async (request) => {
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
	if (!checkRateLimit(ip)) {
		return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
	}

	const user = isCloudMode
		? await verifyAuthToken(request.headers.get("Authorization"))
		: null;

	if (isCloudMode && !user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const roomId = crypto.randomUUID();
	const secret = process.env.ROOM_SIGNING_SECRET;
	const roomToken = secret ? signRoomId(roomId, secret) : undefined;

	// Record room in DB if authenticated
	if (user) {
		const supabase = createServiceClient();
		await supabase
			.from("rooms")
			.insert({ room_id: roomId, owner_user_id: user.id });
	}

	return Response.json({ roomId, roomToken }, { status: 201 });
});

const historyQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const { GET } = apiHandler({}, async (request) => {
	const user = await verifyAuthToken(request.headers.get("Authorization"));
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const parsed = historyQuerySchema.safeParse({
		limit: url.searchParams.get("limit"),
	});

	const limit = parsed.success ? parsed.data.limit : 50;

	const supabase = createServiceClient();
	const { data, error } = await supabase
		.from("rooms")
		.select("*")
		.eq("owner_user_id", user.id)
		.order("created_at", { ascending: false })
		.limit(limit);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}

	return Response.json(data);
});
