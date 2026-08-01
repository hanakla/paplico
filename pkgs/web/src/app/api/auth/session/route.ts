import { createServiceClient } from "@/infra/supabase/server";
import { apiHandler } from "@/utils/nextjs";

export const { GET, dynamic } = apiHandler({}, async (request) => {
	const authHeader = request.headers.get("authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return Response.json({ session: null }, { status: 200 });
	}

	const token = authHeader.slice(7);
	const supabase = createServiceClient();

	const {
		data: { user },
		error,
	} = await supabase.auth.getUser(token);

	if (error || !user) {
		return Response.json({ session: null }, { status: 200 });
	}

	return Response.json({
		session: {
			access_token: token,
			user: {
				id: user.id,
				email: user.email,
				user_metadata: user.user_metadata,
			},
		},
	});
});
