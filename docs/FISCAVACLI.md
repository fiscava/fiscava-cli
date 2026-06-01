# FiscavaCLI

`fiscava` is the first-party command-line interface for trusted local tools and OpenClaw-style agent
runtimes. It uses the existing Fiscava HTTP API boundary; it does not read the web app token store,
localStorage, or MongoDB directly.

> **New to wiring this up?** Start with the linear walkthrough in
> [FISCAVACLI_OPENCLAW_GETTING_STARTED.md](./FISCAVACLI_OPENCLAW_GETTING_STARTED.md). This document
> is the reference manual; the getting-started guide is the tutorial that threads install → login →
> token → verify → OpenClaw config in order.

## Install

```bash
npm install -g @fiscava/cli
fiscava --help
```

(Monorepo development: `npm run build --workspace=@fiscava/cli` then `node apps/cli/dist/index.js`.)

The CLI targets the Fiscava production API automatically — there is no API URL to configure (and no
`--api-url` flag).

## Authentication model

CLI access supports an interactive human login and scoped personal access tokens (PATs).

Sign in with email, password, and your 2FA code or backup code:

```bash
fiscava auth login --email you@example.com
```

The CLI prompts for the password and 2FA code, then stores only the returned token in the token file
(`~/.config/fiscava/token`, mode `0600`). It does not store the account password or 2FA seed.

PATs remain the preferred model for agent runtimes and longer-lived automation:

- token records store only a server-side hash;
- raw tokens are returned once during creation;
- tokens have scopes and expirations;
- tokens can be listed and revoked through `/api/auth/cli-tokens`;
- creating, listing, or revoking tokens requires an authenticated session — `fiscava auth login`
  provides it, so **no browser JWT is needed**.

Create a scoped token (reuses your logged-in session):

```bash
fiscava auth token create \
  --name OpenClaw \
  --scopes profile:read,usage:read,expenses:read,recurring:read,accounts:read,debts:read,networth:read,portfolio:read,export:read \
  --expires 30d
```

Copy the returned `token` value immediately — it is not shown again. (You may instead pass an
explicit `--session-token <jwt>` or `FISCAVA_SESSION_TOKEN` if you'd rather use a browser session
JWT, but it is optional.)

For OpenClaw and other agent runtimes, prefer token files over inline secrets:

```bash
mkdir -p ~/.config/fiscava
printf '%s\n' 'fcv_pat_...' > ~/.config/fiscava/token
chmod 600 ~/.config/fiscava/token
```

Then run commands with:

```bash
fiscava profile get
fiscava expenses list --from 2026-01-01 --to 2026-01-31 --limit 50
fiscava networth summary --fields totalNetWorth,assets,liabilities
```

## Subscription requirements

`fiscava` is a PRO-tier feature (7.17, GitHub #2182). The server gates CLI access in two places:

- `POST /api/auth/cli-tokens` refuses to issue a new token to a FREE-tier user.
- Every authenticated CLI request (PAT or session JWT) re-checks the owner's subscription state
  before the route runs. Tokens are **not** revoked on downgrade — the gate is enforced at
  middleware, so a tier change takes effect on the next call without re-issuing tokens.

| Owner state                          | CLI allowed? | 403 `reason` returned     |
| ------------------------------------ | ------------ | ------------------------- |
| PRO + `active`                       | yes          | —                         |
| PRO + `trial`                        | yes          | —                         |
| PRO + `past_due` within 21-day grace | yes          | — (envelope flags grace)  |
| PRO + `past_due` past 21-day grace   | no           | `past_due_grace_exceeded` |
| PRO + `cancelled`                    | no           | `subscription_cancelled`  |
| PRO + `inactive` / no billing anchor | no           | `subscription_inactive`   |
| FREE (any status)                    | no           | `tier_free`               |
| ADMIN (any status)                   | yes          | —                         |

403 bodies are structured:

```json
{
  "error": "CLI access requires an active Pro subscription.",
  "details": {
    "reason": "tier_free",
    "upgradeUrl": "https://fiscava.app/pricing",
    "retryable": false,
    "graceEndsAt": "2026-06-15T00:00:00.000Z"
  }
}
```

`retryable: false` signals to agent runtimes that the request should not be looped — surface the
upgrade URL to the user and stop. `graceEndsAt` only appears when the owner is in (or just past) the
past_due grace window.

The CLI client does not yet translate these reasons into friendly messages (deferred to #2182
workstream B). For now, an agent runtime that hits any of the above will see the raw 403 body —
parse `details.reason` and surface accordingly.

## Output contract

- JSON is the default output format.
- stdout contains data only.
- diagnostics and structured errors go to stderr.
- exit code `0` means success;
- exit code `1` means an API error;
- exit code `2` means local usage/config error;
- exit code `3` means authentication failed.

Use `--format ndjson` for array payloads that should stream cleanly into line-oriented tools. Use
`--fields a,b,c` to reduce token-heavy payloads for agent context windows.

## Read-only commands

```bash
fiscava auth status
fiscava auth token list
fiscava auth token revoke <id>
fiscava profile get
fiscava usage get
fiscava expenses list --from YYYY-MM-DD --to YYYY-MM-DD --limit 50
fiscava recurring list
fiscava income transactions list --from YYYY-MM-DD --to YYYY-MM-DD --status received
fiscava income summary --from YYYY-MM-DD --to YYYY-MM-DD
fiscava accounts list
fiscava debts list
fiscava savings-goals list
fiscava networth summary
fiscava portfolio summary
fiscava export all --format json
```

`recurring list` returns the existing recurring payment IDs plus readable `category` and
`paymentMethod` objects, so agent runtimes can show labels without a second lookup.

## Expense create (guarded write)

`fiscava expenses create` is JSON-first and keeps API validation as the source of truth.

Requirements:

- the PAT used for this command must include `expenses:create`;
- pass `--yes` for non-interactive writes;
- pass exactly one payload source:
  - `--payload @file.json`
  - `--payload -` (read JSON from stdin)
  - `--payload-json '{"..."}'`
- optionally pass `--idempotency-key <key>` for retryable automation (otherwise the CLI generates
  one);
- duplicate preflight runs by default through `POST /api/expenses/check-duplicate`;
- pass `--allow-duplicate` only when you intentionally want to bypass that preflight;
- `--dry-run` returns normalized metadata without creating the expense.

Example:

```bash
fiscava expenses create \
  --yes \
  --payload @expense.json \
  --idempotency-key expense-create-2026-05-10-001
```

For agent runtimes that only need expense creation, prefer a narrow token such as:

```bash
fiscava auth token create \
  --name ExpenseCreateBot \
  --scopes profile:read,expenses:create \
  --expires 30d
```

Create success output is wrapped as:

```json
{
  "idempotencyKey": "expense-create-2026-05-10-001",
  "dryRun": false,
  "result": {
    "...": "API response payload"
  }
}
```

## Income transaction create (guarded write)

`fiscava income transactions create` posts a JSON payload to `POST /api/income-transactions`.

Requirements:

- the PAT used for this command must include `income:create`;
- pass `--yes` for non-interactive writes;
- pass exactly one payload source: `--payload @file.json`, `--payload -`, or `--payload-json`;
- optionally pass `--idempotency-key <key>` for retryable automation;
- `--dry-run` returns the payload and idempotency key without writing.

Example:

```bash
fiscava income transactions create \
  --yes \
  --payload @income-transaction.json \
  --idempotency-key income-create-2026-05-16-001
```

Income create uses the API's idempotency-key path for retry safety. While the key is unexpired,
retrying a successful create with the same key replays the original income transaction across both
contract-backed and legacy API create paths. It does not run a separate domain-level duplicate
preflight, so use a new key only when you intentionally want another income transaction. If a retry
arrives while the original legacy create is still in progress, the API may return a conflict instead
of creating a duplicate; retry again after the original request completes.

## Recurring create (guarded write)

`fiscava recurring create` posts a JSON payload to `POST /api/recurring`.

Requirements:

- the PAT used for this command must include `recurring:create`;
- pass `--yes` for non-interactive writes;
- pass exactly one payload source: `--payload @file.json`, `--payload -`, or `--payload-json`;
- optionally pass `--idempotency-key <key>` for retryable automation;
- similar-recurring checks remain enabled by default;
- pass `--allow-similar` only when intentionally bypassing the similar-recurring guard;
- `--dry-run` returns the payload and idempotency key without writing.

Example:

```bash
fiscava recurring create \
  --yes \
  --payload @recurring-payment.json \
  --idempotency-key recurring-create-2026-05-16-001
```

`--allow-similar` maps to the existing API `ignoreDuplicates` flag.

Recurring create stores idempotency state separately from the recurring payment. While the key is
unexpired, retrying the same key replays the original payment. If the original payment was hard
deleted before the key expires, the API returns a conflict instead of creating a replacement with
the same key. After the key expires, reuse is treated as a new create request and still goes through
the similar-recurring guard unless `--allow-similar` is supplied.

## OpenClaw usage

After `npm install -g @fiscava/cli`, the `fiscava` binary is on your `PATH` (use the absolute path
from `which fiscava` in OpenClaw config). OpenClaw jobs/harnesses need only **one** env var — the
token file. The API URL is built in.

```bash
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/agent-token
```

Do not paste PATs into prompts. Store the token in a `0600` file and let the CLI read it. Keep
scopes narrow for the agent's task; for example, use `profile:read,expenses:read` for expense
inspection rather than broad export access.

See [FISCAVACLI_OPENCLAW_GETTING_STARTED.md](./FISCAVACLI_OPENCLAW_GETTING_STARTED.md) for the MCP
server, slash-command, and `before_dispatch` hook integration patterns.
