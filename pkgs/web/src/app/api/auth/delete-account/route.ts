import { createServiceClient, verifyAuthToken } from "@/infra/supabase/server";
import { apiHandler } from "@/utils/nextjs";

export const { POST, dynamic } = apiHandler({}, async (request) => {
	const user = await verifyAuthToken(request.headers.get("authorization"));
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { error } = await createServiceClient().auth.admin.deleteUser(user.id);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}

	return Response.json({ success: true });
});
