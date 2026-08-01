/**
 * Next.js 16 proxy.ts — request interception layer
 *
 * - Local mode: pass-through (no auth)
 * - Cloud mode: Clerk session injection (no redirects — lazy auth)
 *
 * Authentication is NOT enforced here. Users can access the canvas
 * without logging in. Auth is only required when connecting to a
 * collaboration room (handled client-side via SignInDialog).
 */

import { type NextRequest, NextResponse } from "next/server";

const isDevelopment = process.env.NODE_ENV !== "production";
const storybookDevOrigin =
	process.env.NEXT_PUBLIC_STORYBOOK_DEV_ORIGIN ?? "http://localhost:6006";

export default function proxy(request: NextRequest) {
	if (isDevelopment) {
		const storybookRedirect = createStorybookRedirect(request);
		if (storybookRedirect) return storybookRedirect;
	}

	return NextResponse.next();
}

function createStorybookRedirect(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	if (!pathname.startsWith("/storybook")) return null;

	const storybookPath = pathname === "/storybook" ? "/" : pathname.slice(10);
	const redirectUrl = new URL(`${storybookPath}${search}`, storybookDevOrigin);
	return NextResponse.redirect(redirectUrl);
}

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
