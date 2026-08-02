# @paplico/partykit-collab-server

PartyKit collaboration server for Paplico.
Yjs document synchronization and Supabase JWT authentication at the edge.

## Deployment

Deployed automatically via GitHub Actions on every push to `main`.
Manual deployment is also available via `workflow_dispatch` on the Actions tab.

### Prerequisites

Add the following GitHub repository secrets:

- `PARTYKIT_LOGIN` — generated via `npx partykit login`
- `PARTYKIT_TOKEN` — generated via `npx partykit token generate`

Set the Supabase JWT secret as a PartyKit environment variable:

```bash
npx partykit env add SUPABASE_JWT_SECRET
```

### Manual Deploy

```bash
npx partykit deploy
```

## Version Identification

The deploy commit hash is embedded at compile time via `DEPLOY_COMMIT_HASH`.
Query the server version via HTTP GET:

```
GET https://paplico.<username>.partykit.dev/party/<roomId>
-> { "version": "abc123def..." }
```

During local development (`partykit dev`), the version is `"dev"`.

## Compatibility Policy

This server maintains backward compatibility with the **previous 1 release (N-1)**.

### What this means

- The current server version (N) is guaranteed to work with clients built against the previous release (N-1).
- Clients older than N-1 are not guaranteed to work and should be updated.

### Scope

The Yjs sync protocol (provided by y-partykit) is inherently stable. The N-1 compatibility covers custom additions:

- JWT authentication flow and token format
- Room metadata schema (Durable Object KV)
- Awareness state fields (cursor, user info)
- HTTP API (version endpoint response format)

### Breaking changes

When a breaking change is unavoidable:

1. Deploy the new server with backward-compatible handling for N-1 clients
2. Deploy the updated client (Vercel)
3. After confirming all clients have updated, the compatibility shim may be removed in a subsequent release
