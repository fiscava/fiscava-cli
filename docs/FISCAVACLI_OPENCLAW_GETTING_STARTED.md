# FiscavaCLI + OpenClaw — Getting Started

A linear walkthrough from "nothing installed" to "OpenClaw agent making real Fiscava queries through
`fiscava`". Each step is independently verifiable.

For the comprehensive command reference and authentication model, see
[FISCAVACLI.md](./FISCAVACLI.md). For deploy-only instructions, see
[apps/cli/README.md](../apps/cli/README.md). This document is the opinionated tutorial that threads
the two together.

> **Scope note.** This guide shows the invocation pattern OpenClaw uses to call `fiscava` (bash
> subprocess + two env vars) and gives an integration sketch for each OpenClaw surface (MCP server,
> slash command, `before_dispatch` hook). The exact OpenClaw config file format (paths, JSON/YAML
> schema) is **not** prescribed here — it lives in OpenClaw's own docs at
> <https://docs.openclaw.ai/cli/mcp> and <https://docs.openclaw.ai/tools/acp-agents>. The bash
> commands and env vars below are stable; the wrapping config is OpenClaw's surface area.

---

## Prerequisites

Before you start, confirm:

- [ ] Node.js 20+ and npm (matches the monorepo's engines field).
- [ ] You have the ExpenseFlow repo checked out and `npm install` has succeeded.
- [ ] Fiscava API URL you can reach. For local dev that's usually `http://localhost:4000`; for
      staging `https://api.staging.fiscava.app`.
- [ ] OpenClaw is installed and you can run it. (If you're testing without OpenClaw, you can verify
      the CLI end-to-end with the `auth status` / `profile get` commands in step 4 — OpenClaw enters
      the picture in step 5.)
- [ ] A Fiscava browser session (you're signed in at the web app) so you can copy a session JWT for
      the one-time token creation step.
- [ ] **Your Fiscava account is on the PRO tier** (or in Pro trial, or ADMIN). 7.17 (GitHub #2182)
      gates `fiscava` behind PRO. FREE-tier accounts will hit `403 {reason: "tier_free"}` on step 2
      (`auth token create`) before a token can be issued. PRO accounts on `past_due` keep working
      through a 21-day grace window. See the
      [Subscription requirements section in FISCAVACLI.md](./FISCAVACLI.md#subscription-requirements)
      for the full decision matrix.

---

## Step 1 — Build and deploy fiscava

From the repo root:

```bash
npm install
npm run deploy:openclaw
```

`deploy:openclaw` builds `apps/cli` and copies the dist + entrypoint script to:

```
~/.openclaw/plugins/fiscava/fiscava-cli/
```

The runtime command lands at:

```
~/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava
```

**Override the destination** (e.g. multiple OpenClaw profiles, or a shared host):

```bash
npm run deploy:openclaw -- --dest "$HOME/.openclaw/plugins/fiscava/fiscava-cli"
# or
OPENCLAW_FISCAVA_CLI_DIR="$HOME/.openclaw/plugins/fiscava/fiscava-cli" \
  npm run deploy:openclaw
```

**Verify** the deployed binary exists and runs:

```bash
~/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava --help
```

The deploy script never touches token files or runtime config — those live in step 3.

---

## Step 2 — Create a scoped agent token

OpenClaw should never use a session JWT directly. Create a scoped Personal Access Token (PAT) once,
then revoke and re-issue when scopes need to change.

You'll need:

- a **Fiscava session JWT** — copy it from your browser's authenticated session (DevTools →
  Application → Cookies / localStorage, depending on how the web app stores it);
- a clear understanding of what scopes the agent actually needs (see the scope table below — prefer
  the narrowest set).

```bash
export FISCAVA_API_URL=https://your-fiscava-api.example.com
export FISCAVA_SESSION_TOKEN='<browser session JWT — paste once, then unset>'

~/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava auth token create \
  --name OpenClaw \
  --scopes profile:read,expenses:read,recurring:read,accounts:read,networth:read \
  --expires 30d
```

The response includes a `token` field that starts with `fcv_pat_`. **Copy it immediately** — the raw
value is never shown again (only a server-side hash is stored).

Unset the session token from your shell right after:

```bash
unset FISCAVA_SESSION_TOKEN
```

### Scope quick reference

The full list lives in [apps/api/models/CliToken.types.ts](../apps/api/models/CliToken.types.ts).
Common bundles:

| Use case                                                 | Scopes                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Read-only inspection (agent answers "what did I spend?") | `profile:read,expenses:read,recurring:read,accounts:read,networth:read` |
| Read + portfolio reasoning                               | add `portfolio:read,debts:read,savings-goals:read,income:read`          |
| Expense create automation only                           | `profile:read,expenses:create`                                          |
| Full data export workflow                                | `profile:read,export:read`                                              |

Avoid blanket scopes (`*:read`) — keep agent tokens narrow.

---

## Step 3 — Configure the runtime environment

OpenClaw passes two env vars into every `fiscava` invocation:

```bash
FISCAVA_API_URL=https://your-fiscava-api.example.com
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token
```

Drop the PAT from step 2 into the token file:

```bash
mkdir -p "$HOME/.config/fiscava"
printf '%s\n' 'fcv_pat_...' > "$HOME/.config/fiscava/token"
chmod 600 "$HOME/.config/fiscava/token"
```

**File permission matters** — `fiscava` will refuse to read a world-readable token file.

**API URL gotcha**: pass the API **origin** only — do not append `/api`. Internal command paths
already include it. Wrong: `https://your-api.example.com/api`. Right:
`https://your-api.example.com`.

For local development:

```bash
FISCAVA_API_URL=http://localhost:4000
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token
```

---

## Step 4 — Verify the runtime end-to-end ("hello world")

Run from the **deployed copy**, not the repo checkout — that's what OpenClaw will run, and running
the dist proves the deploy worked.

**4a. Auth status** — local-only sanity check. Confirms the CLI can find the token file (or
flag/env) and reports which API URL it would call. **Does NOT contact the server**, so it doesn't
verify the token is real, unexpired, or scoped correctly.

```bash
FISCAVA_API_URL=http://localhost:4000 \
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token \
~/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava auth status
```

Expected: `{ "authenticated": true, "apiUrl": "...", "tokenSource": "token-file-or-env" }` (or
`"flag"` / `"env"` / `"none"`). `authenticated: true` here only means a non-empty token was found —
it could still be revoked, expired, or for the wrong instance. The first server-side validation
happens in 4b.

**4b. Profile get** — first server-side round-trip. Confirms the API is reachable, the token is
valid and unexpired, and the token has `profile:read`.

```bash
FISCAVA_API_URL=http://localhost:4000 \
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token \
~/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava profile get
```

**4c. A real data query** — confirms the API + DB are reachable and your scope mix is correct.

```bash
FISCAVA_API_URL=http://localhost:4000 \
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token \
~/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava \
  expenses list --from 2026-01-01 --to 2026-01-31 --limit 5
```

If all three return JSON cleanly to stdout (no errors on stderr, exit code 0), you have a working
agent runtime independent of OpenClaw. Continue to step 5.

If any step fails, jump to **Troubleshooting** below before wiring OpenClaw on top.

---

## Step 5 — Wire `fiscava` into OpenClaw

OpenClaw has three integration surfaces for calling external binaries. Pick the narrowest one that
matches your workflow:

| Surface                | When to use                                                                  | Trigger                  |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------ |
| MCP server             | The agent should be able to query Fiscava during its own reasoning           | Agent emits a tool call  |
| Slash command          | User explicitly wants a Fiscava view (`/fiscava-expenses ...`)               | User invokes the command |
| `before_dispatch` hook | A deterministic Fiscava query should always run before the LLM is dispatched | Hook fires per dispatch  |

All three end up running the same bash command (the verified one from step 4) — they differ only in
OpenClaw's wrapper config.

### 5a. MCP server integration

OpenClaw discovers tools via its MCP server config. The agent sees tools like `fiscava_profile_get`
or `fiscava_expenses_list` and can call them with structured arguments.

The relevant **invocation** is just `fiscava` as a subprocess with the env vars above — OpenClaw's
MCP-bridge runs the command and surfaces stdout as the tool result. Concrete shape (consult
OpenClaw's MCP config schema for the exact wrapping; the command, args, and env are what matter):

```jsonc
// OpenClaw MCP config — sketch only, see docs.openclaw.ai/cli/mcp for the
// authoritative schema. The fields below are the values OpenClaw needs;
// the surrounding object shape is OpenClaw's responsibility.
{
  "name": "fiscava",
  "command": "/Users/<you>/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava",
  "args": ["profile", "get", "--format", "json"],
  "env": {
    "FISCAVA_API_URL": "https://your-fiscava-api.example.com",
    "FISCAVA_TOKEN_FILE": "/Users/<you>/.config/fiscava/token",
  },
}
```

Wrap one entry per Fiscava command you want the agent to use (one for `profile get`, one for
`expenses list`, etc.) — narrow tool surfaces are easier to audit than a generic "run fiscava with
these args" wildcard.

**Verify** by listing OpenClaw's available tools after a reload — the `fiscava_*` tools should
appear. Run a one-shot agent prompt that names the tool ("call `fiscava_profile_get`") and confirm
the response carries the same JSON `fiscava profile get` returned in step 4b.

### 5b. Slash command integration

Slash commands fire only on explicit user invocation (`/fiscava-recent`). They're simpler than MCP
because the agent doesn't reason about when to call them.

The integration sketch is the same shape as MCP — OpenClaw runs the binary, captures stdout,
substitutes it into the conversation. The relevant bash invocation:

```bash
FISCAVA_API_URL=https://your-fiscava-api.example.com \
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token \
$HOME/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava \
  expenses list --from 2026-01-01 --to 2026-01-31 --limit 25 --format ndjson
```

`--format ndjson` is friendlier than the default JSON when the agent will be parsing or the user
wants to pipe into line-oriented tools.

Wrap this in OpenClaw's slash-command file format (markdown frontmatter or YAML — check OpenClaw's
docs for the current shape) so the command name maps to the bash invocation.

**Verify** by typing the slash command in OpenClaw and confirming the JSON arrives in the
conversation.

### 5c. `before_dispatch` hook integration

Hooks run before every LLM dispatch. Use them sparingly — they fire on **every** turn, so they add
latency and token cost.

Good fit: a small, fast, deterministic Fiscava query whose result should always be in context (e.g.
inject the user's current monthly burn rate before any agent reasoning).

Bad fit: anything large, slow, or expensive — those belong in MCP (called on demand) or a slash
command (called explicitly).

The hook runs the same bash command pattern:

```bash
FISCAVA_API_URL=https://your-fiscava-api.example.com \
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/token \
$HOME/.openclaw/plugins/fiscava/fiscava-cli/bin/fiscava \
  networth summary --fields totalNetWorth --format json
```

Wrap in OpenClaw's hook config file. The hook's stdout becomes part of the dispatch context.

**Verify** by triggering an agent turn and confirming the networth summary appears in the context
surfaced to the model (OpenClaw usually exposes this in its debug log).

---

## Troubleshooting

| Symptom                                                | Likely cause                                                                                           | Fix                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `exit code 3 — authentication failed`                  | Token file missing, unreadable, empty, or `FISCAVA_TOKEN_FILE` points to wrong path                    | `ls -l "$FISCAVA_TOKEN_FILE"` to confirm; recreate with `chmod 600` from step 3                                                     |
| `401 Unauthorized`                                     | Token expired or revoked                                                                               | Repeat step 2 to issue a new PAT, replace token file contents                                                                       |
| `403 Forbidden` on a specific command                  | Token's scopes don't include what the command needs                                                    | Revoke the PAT (`fiscava auth token revoke <id> --session-token '<jwt>'`), re-issue with the missing scope                          |
| `403` with `details.reason: "tier_free"`               | Owner of the token (or session) is on FREE tier; 7.17 gates `fiscava` to PRO                           | Upgrade the Fiscava account at the URL in `details.upgradeUrl`. Token does not need to be re-issued — the gate re-checks per call   |
| `403` with `details.reason: "past_due_grace_exceeded"` | Owner's Pro subscription went `past_due` 21+ days ago                                                  | Resolve billing in Stripe / via the in-app `/settings/subscription` portal. Access resumes on the next call after status flips back |
| `403` with `details.reason: "subscription_cancelled"`  | Owner cancelled their Pro subscription                                                                 | Re-subscribe; the existing token will start working again on the next call (tokens are not revoked on downgrade)                    |
| `403` with `details.reason: "subscription_inactive"`   | Owner's subscription is in an unrecognised state, or `past_due` with no billing anchor on the user doc | Check the user's `subscription` doc; resolve billing or contact ops if the record is malformed                                      |
| `404 Not Found` on every command                       | `FISCAVA_API_URL` includes `/api` suffix                                                               | Drop the suffix — pass the origin only                                                                                              |
| `exit code 2 — local usage error`                      | Bad arg, missing required flag                                                                         | Re-read `fiscava <command> --help`; flags differ between read and write commands                                                    |
| OpenClaw says "tool fiscava_X not found"               | MCP server config didn't reload, or path to binary is wrong                                            | Reload OpenClaw; verify the binary path is the deployed `~/.openclaw/.../bin/fiscava`, not the repo `apps/cli/dist/index.js`        |
| Hook runs but stdout is empty in the agent context     | Hook is reading stderr, or hook timeout is shorter than command latency                                | Check OpenClaw's hook timeout; ensure JSON is on stdout (it is by default — only diagnostics go to stderr)                          |
| Token file write succeeds but CLI still fails          | File permission too open (`644`)                                                                       | `chmod 600 "$FISCAVA_TOKEN_FILE"`                                                                                                   |

### Exit code contract

`fiscava` follows a fixed exit code contract so OpenClaw hooks and CI can branch deterministically:

- `0` — success
- `1` — API returned an error (network, 4xx, 5xx)
- `2` — local usage / config error (bad flag, missing payload file, malformed JSON)
- `3` — authentication failed

---

## Day-2 operations

**Rotate the agent token** — every 30 days for `--expires 30d`, or sooner if the agent's scopes
change:

```bash
# Identify the active token
fiscava auth token list --session-token '<jwt>'

# Revoke the old one
fiscava auth token revoke <id> --session-token '<jwt>'

# Issue a new one with the right scopes (step 2), drop into the token file (step 3)
```

**Upgrade the deployed CLI** when ExpenseFlow ships new commands or fixes:

```bash
git pull
npm install
npm run deploy:openclaw
```

The deploy script overwrites the dist + entrypoint but leaves the token file and OpenClaw config
alone, so reloading OpenClaw is the only follow-up.

**Switch API target** (e.g. staging ↔ local) — change only the `FISCAVA_API_URL` env in OpenClaw's
config. The token is per-user, not per-env; if you're switching to a different Fiscava instance
entirely (different user database), re-do step 2 against the new instance.

---

## Pointers

- [docs/FISCAVACLI.md](./FISCAVACLI.md) — comprehensive command reference, auth model, output
  contract, write-command guards.
- [apps/cli/README.md](../apps/cli/README.md) — deploy-only quick reference.
- [apps/api/models/CliToken.types.ts](../apps/api/models/CliToken.types.ts) — authoritative scope
  list.
- <https://docs.openclaw.ai/cli/mcp> — OpenClaw's MCP config schema (external).
- <https://docs.openclaw.ai/tools/acp-agents> — OpenClaw's ACP harness model (external).
