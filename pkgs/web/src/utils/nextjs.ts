import type { NextRequest } from "next/server";

type RouteContext<P = Record<string, string>> = {
	params: Promise<P>;
};

export const apiHandler = <P = Record<string, string>>(
	{
		dynamic = "force-dynamic",
	}: {
		dynamic?: "force-dynamic";
	},
	cb: (
		req: NextRequest,
		context: RouteContext<P>,
	) => Promise<Response> | Response,
) => {
	const wrapped = async (req: NextRequest, context: RouteContext<P>) => {
		try {
			return await cb(req, context);
		} catch (e) {
			return Response.json(
				{
					success: false,
					message: `Internal server error: ${e instanceof Error ? e.message : String(e)}`,
				},
				{
					status: 500,
				},
			);
		}
	};

	return {
		dynamic,
		GET: wrapped,
		POST: wrapped,
	};
};
