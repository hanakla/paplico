/**
 * Next.js 16 proxy.ts — request interception layer
 *
 * - Local mode: pass-through (no auth)
 * - Cloud mode: Clerk session injection (no redirects — lazy auth)
 * - API: CORS for the desktop build, which calls this server from its own origin
 *
 * Authentication is NOT enforced here. Users can access the canvas
 * without logging in. Auth is only required when connecting to a
 * collaboration room (handled client-side via SignInDialog).
 */

import { type NextRequest, NextResponse } from "next/server";

const isDevelopment = process.env.NODE_ENV !== "production";
const storybookDevOrigin =
	process.env.NEXT_PUBLIC_STORYBOOK_DEV_ORIGIN ?? "http://localhost:6006";

/** Origins the desktop build's webview serves its pages from (macOS/Linux, Windows). */
const DESKTOP_ORIGINS = new Set([
	"tauri://localhost",
	"http://tauri.localhost",
]);

export default function proxy(request: NextRequest) {
	if (isDevelopment) {
		const storybookRedirect = createStorybookRedirect(request);
		if (storybookRedirect) return storybookRedirect;
	}

	const origin = request.headers.get("Origin");
	if (
		origin &&
		DESKTOP_ORIGINS.has(origin) &&
		request.nextUrl.pathname.startsWith("/api/")
	) {
		return withDesktopCors(request, origin);
	}

	return NextResponse.next();
}

/**
 * Lets the desktop build call the API. Its requests carry an Authorization
 * header, so the browser preflights them — and no route exports OPTIONS, so
 * the preflight is answered here before it reaches one.
 */
function withDesktopCors(request: NextRequest, origin: string) {
	const headers = {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	};

	if (request.method === "OPTIONS") {
		return new NextResponse(null, { status: 204, headers });
	}

	return NextResponse.next({ headers });
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
