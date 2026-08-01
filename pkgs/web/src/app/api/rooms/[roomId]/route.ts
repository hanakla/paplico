import { prettifyError, z } from "zod";
import { createServiceClient, verifyAuthToken } from "@/infra/supabase/server";
import { apiHandler } from "@/utils/nextjs";

const patchSchema = z.object({
	roomId: z.string().min(1),
	closed_at: z.string(),
});

export const { POST: PATCH, dynamic } = apiHandler<{ roomId: string }>(
	{},
	async (request, { params }) => {
		const user = await verifyAuthToken(request.headers.get("Authorization"));
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const parsed = patchSchema.safeParse({
			...(await params),
			...(await request.json()),
		});
		if (!parsed.success) {
			return Response.json(
				{ error: prettifyError(parsed.error) },
				{ status: 400 },
			);
		}

		const { roomId, closed_at } = parsed.data;
		const supabase = createServiceClient();
		const { error } = await supabase
			.from("rooms")
			.update({ closed_at })
			.eq("room_id", roomId)
			.eq("owner_user_id", user.id);

		if (error) {
			return Response.json({ error: error.message }, { status: 500 });
		}

		return Response.json({ success: true });
	},
);
