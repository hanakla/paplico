declare namespace Cloudflare {
	interface Env {
		Main: DurableObjectNamespace<import("./document").DocumentServer>;
		Relay: DurableObjectNamespace<import("./relay").RelayServer>;
		SUPABASE_JWT_SECRET?: string;
		ROOM_SIGNING_SECRET?: string;
	}
}

type Env = Cloudflare.Env;
