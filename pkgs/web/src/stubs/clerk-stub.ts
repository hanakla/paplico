// Stub module for @clerk/nextjs in Tauri (static export) builds.
// Replaces the real package via turbopack.resolveAlias to avoid
// server action imports that are incompatible with output: "export".

export function ClerkProvider({ children }: { children: React.ReactNode }) {
	return children;
}

const NOOP = () => ({});
export const useAuth = NOOP;
export const useClerk = NOOP;
export const useSignIn = NOOP;
export const useUser = NOOP;
export const useSignUp = NOOP;

export function AuthenticateWithRedirectCallback() {
	return null;
}
