# @paplico/partykit-collab-server

PartyServer collaboration server for Paplico, running as a Cloudflare Worker with Durable Objects.
Yjs document synchronization and Supabase JWT authentication at the edge.

| Path                   | Durable Object   | Purpose                                     |
| ---------------------- | ---------------- | ------------------------------------------- |
| `/parties/main/:room`  | `DocumentServer` | Yjs sync, room metadata, document snapshots |
| `/parties/relay/:room` | `RelayServer`    | Stateless relay for E2EE sessions           |

## Deployment

Deployed automatically via GitHub Actions on every push to `main`.
Manual deployment is also available via `workflow_dispatch` on the Actions tab.

### Prerequisites

Add the following secrets to the `Production` environment of the GitHub repository:

- `CLOUDFLARE_API_TOKEN` — an Account API token with `Workers Scripts: Edit` and `Account Settings: Read`
- `CLOUDFLARE_ACCOUNT_ID`
- `ROOM_SIGNING_SECRET` — must match the web app's, which signs the room tokens

The workflow uploads `ROOM_SIGNING_SECRET` as a Worker secret on every deploy. It also sets `SUPABASE_URL` from the repository secret `SUPABASE_PROD_PROJECT_REF`, so the server verifies session tokens against that project's JWKS. The server refuses every connection while either is missing.

Supabase must sign session tokens with an asymmetric key, such as ES256. A shared-secret HS256 key is not published in the JWKS.

### Manual Deploy

```bash
npx wrangler login
npx wrangler deploy --var SUPABASE_URL:https://<project-ref>.supabase.co
```

## Local Development

`yarn dev` at the repository root starts this server with `wrangler dev` on port 1999.
Put the settings in `.dev.vars` next to `wrangler.jsonc`:

```
SUPABASE_URL=http://127.0.0.1:54321
ROOM_SIGNING_SECRET=...
```

## Compatibility Policy

This server maintains backward compatibility with the **previous 1 release (N-1)**.

### What this means

- The current server version (N) is guaranteed to work with clients built against the previous release (N-1).
- Clients older than N-1 are not guaranteed to work and should be updated.

### Scope

The Yjs sync protocol (provided by y-partyserver) is inherently stable. The N-1 compatibility covers custom additions:

- JWT authentication flow and token format
- Room metadata schema (Durable Object storage)
- Awareness state fields (cursor, user info)
- HTTP API (room metadata response format)

### Breaking changes

When a breaking change is unavoidable:

1. Deploy the new server with backward-compatible handling for N-1 clients
2. Deploy the updated client (Vercel)
3. After confirming all clients have updated, the compatibility shim may be removed in a subsequent release
