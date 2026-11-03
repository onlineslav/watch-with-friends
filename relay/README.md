The optional Worker issues one-hour TURN credentials. It stores no rooms, profiles, or media. Its API token stays in Cloudflare's secret storage. The Electron build contains only the HTTPS endpoint.

To set up your own deployment, run from this directory:

```sh
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
npx wrangler deploy
```

Set `config/turn.json` to `{"endpoint":"https://YOUR-WORKER.workers.dev/credentials"}` before building. Configure a unique rate-limit namespace for your account if `71004` is already in use. The broker denies issuance if its rate-limit binding is missing. It allows ten requests per minute per client IP; the desktop caches and renews credentials before expiry. [Cloudflare documents the rate-limit binding and its per-location scope](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

This is an anonymous service: anyone who knows the endpoint can request expiring credentials subject to that limit. Rate limiting is not an account-wide spending cap. Monitor TURN usage and add authenticated access at this endpoint if distributing beyond a small group. Do not put a shared secret in the desktop to identify legitimate installs. [Cloudflare's credential guidance](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

For a private local relay, put `{"iceServers":[{"urls":"turn:YOUR-HOST:3478","username":"YOUR-USER","credential":"YOUR-CREDENTIAL"}]}` in the application's user-data `turn.json`. Static credentials are never accepted by the packaging hook. Development can also load that local configuration from `config/turn.json`, but the build rejects it.

No deployment is created by building or testing this repository. If a previous installer shipped a Cloudflare minting token, revoke it separately; changing the code cannot revoke installed copies.

## Development telemetry

The same Worker's `/telemetry` route receives logs from apps whose owner ticked Settings → "Send telemetry for development" (off by default). Each upload is committed to a private GitHub repository as `telemetry/<username>/<day>/<time>.log.gz`. The app never holds the token; it only knows the address.

One-time setup:

1. Create a fine-grained GitHub token at <https://github.com/settings/personal-access-tokens/new>: repository access "Only select repositories" → `watch-with-friends-diagnostics`, permission **Contents: Read and write**, nothing else.
2. From this directory: `npx wrangler login`, then `npx wrangler secret put DIAGNOSTICS_GITHUB_TOKEN` (paste the token), then `npx wrangler deploy`. `DIAGNOSTICS_REPO` is set in `wrangler.jsonc`.
3. Add the route to the build's config: `{"telemetry":"https://YOUR-WORKER.workers.dev/telemetry"}` (beside `endpoint` if you use TURN). For CI that's the `TURN_CONFIG` repository secret; for a local build, `config/turn.json`.

Reading: `npm run diagnostics` from the repository root. Anyone with read access to the diagnostics repository can run it with their own `gh` login. Uploads share the ten-requests-a-minute limit with `/credentials`; an app uploads at most every few minutes.
