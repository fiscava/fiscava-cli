# Fiscava CLI + OpenClaw — Getting Started

`@fiscava/cli` (command: `fiscava`) lets you read and act on your Fiscava finances from the
terminal, and lets AI agents (Claude Code, OpenClaw, Cursor) do the same through **scoped,
revocable** tokens — never your password.

This guide takes you from install → signed in → a scoped agent token → wired into OpenClaw. It is
written for the **public package**: the CLI targets the Fiscava production API automatically — there
is no API URL to configure.

## Prerequisites

- [ ] **Node.js 20+** (`node --version`).
- [ ] A **Fiscava PRO account**. CLI access is a PRO feature; the API re-checks your subscription on
      every request, so a token only works while PRO is active. Sign up / upgrade at
      <https://fiscava.app>.
- [ ] For the OpenClaw section: **OpenClaw installed** and its plugin/config dir available.

You do **not** need a Fiscava API URL or a browser session token — both are handled for you (the API
is hardcoded to production; auth is via `fiscava auth login`).

---

## Step 1 — Install

```bash
npm install -g @fiscava/cli
fiscava --help        # sanity check; prints the command list
```

That's the whole install. `fiscava` is now on your `PATH`.

---

## Step 2 — Sign in

```bash
fiscava auth login --email you@example.com
```

You'll be prompted for your password and, if enabled, your 2FA code. On success the CLI stores the
returned token at `~/.config/fiscava/token` (created `0600`). No browser, no JWT copy-paste, no API
URL.

Verify:

```bash
fiscava auth status   # { "authenticated": true, "tokenSource": "token-file-or-env", ... }
fiscava profile get   # first real server round-trip — proves the token works
```

`auth status` is local-only (it just confirms a token is present). `profile get` is the first call
that actually contacts the API.

---

## Step 3 — Create a scoped token for your agent

Your login token is broad. Don't hand it to an agent. Instead mint a **narrow, revocable Personal
Access Token (PAT)** — this reuses the session you just logged in with, so there's nothing else to
paste:

```bash
fiscava auth token create \
  --name "Claude Code" \
  --scopes profile:read,expenses:read,recurring:read,networth:read \
  --expires 30d
```

The response includes a `token` starting with `fcv_pat_`. **Copy it now — the raw value is shown
once** (only a server-side hash is stored). Drop it into a token file dedicated to the agent (kept
separate from your personal session):

```bash
mkdir -p ~/.config/fiscava
printf '%s\n' 'fcv_pat_...' > ~/.config/fiscava/agent-token
chmod 600 ~/.config/fiscava/agent-token
```

`fiscava` refuses to read a token file that is group- or world-readable.

### Scope quick reference

The full list lives in [apps/api/models/CliToken.types.ts](../apps/api/models/CliToken.types.ts).
Common bundles:

| Use case                                                 | Scopes                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Read-only inspection (agent answers "what did I spend?") | `profile:read,expenses:read,recurring:read,accounts:read,networth:read` |
| Read + portfolio reasoning                               | add `portfolio:read,debts:read,savings-goals:read,income:read`          |
| Expense create automation only                           | `profile:read,expenses:create`                                          |
| Full data export workflow                                | `profile:read,export:read`                                              |

Keep agent tokens narrow — grant only what the workflow needs.

---

## Step 4 — Verify the agent token

Point the CLI at the agent's token file and run the same checks. This is what OpenClaw will run.

```bash
export FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/agent-token

fiscava auth status   # authenticated: true, tokenSource: token-file-or-env
fiscava profile get   # API reachable + token valid + has profile:read
fiscava expenses list --from 2026-01-01 --to 2026-01-31 --limit 5
```

If all three return JSON cleanly on stdout (no stderr, exit code 0), you have a working agent
runtime. If any fails, see **Troubleshooting** before wiring OpenClaw on top.

---

## Step 5 — Wire `fiscava` into OpenClaw

OpenClaw has three surfaces for calling an external binary. Pick the narrowest one that matches the
workflow:

| Surface                | When to use                                                          | Trigger                  |
| ---------------------- | -------------------------------------------------------------------- | ------------------------ |
| MCP server             | The agent should query Fiscava during its own reasoning              | Agent emits a tool call  |
| Slash command          | User explicitly wants a Fiscava view (`/fiscava-expenses ...`)       | User invokes the command |
| `before_dispatch` hook | A deterministic query should always run before the LLM is dispatched | Hook fires per dispatch  |

All three run the same command — only the OpenClaw wrapper differs. They need just **one** env var,
`FISCAVA_TOKEN_FILE` (the API URL is built in). Use the absolute path to the installed binary in
OpenClaw config (`which fiscava` to find it — it's under your npm global bin, e.g.
`/usr/local/bin/fiscava`).

### 5a. MCP server integration

The agent sees tools like `fiscava_profile_get` / `fiscava_expenses_list` and calls them with
structured args; OpenClaw runs the subprocess and surfaces stdout as the tool result.

```jsonc
// OpenClaw MCP config — sketch only; see docs.openclaw.ai/cli/mcp for the
// authoritative schema. command/args/env are the values that matter.
{
  "name": "fiscava",
  "command": "/usr/local/bin/fiscava", // output of `which fiscava`
  "args": ["profile", "get", "--format", "json"],
  "env": {
    "FISCAVA_TOKEN_FILE": "/Users/<you>/.config/fiscava/agent-token",
  },
}
```

Wrap one entry per command you want the agent to use (one for `profile get`, one for
`expenses list`, …) — narrow tool surfaces are easier to audit than a wildcard "run fiscava with any
args."

**Verify:** reload OpenClaw, confirm the `fiscava_*` tools appear, prompt the agent to call
`fiscava_profile_get`, and check the JSON matches step 4.

### 5b. Slash command integration

Fires only on explicit user invocation (`/fiscava-recent`). Same shape as MCP; the relevant
invocation:

```bash
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/agent-token \
  fiscava expenses list --from 2026-01-01 --to 2026-01-31 --limit 25 --format ndjson
```

`--format ndjson` is friendlier when the agent parses output or the user pipes into line-oriented
tools. Wrap it in OpenClaw's slash-command file format.

### 5c. `before_dispatch` hook integration

Hooks run before **every** LLM dispatch, so use them sparingly (latency + token cost). Good fit: a
small, fast, deterministic query whose result should always be in context (e.g. current monthly burn
rate):

```bash
FISCAVA_TOKEN_FILE=$HOME/.config/fiscava/agent-token \
  fiscava networth summary --fields totalNetWorth --format json
```

Anything large/slow belongs in MCP (on demand) or a slash command (explicit). The hook's stdout
becomes part of the dispatch context.

---

## Troubleshooting

| Symptom                                                | Likely cause                                                                            | Fix                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `exit code 3 — authentication failed`                  | Token file missing, unreadable, empty, or `FISCAVA_TOKEN_FILE` points to the wrong path | `ls -l "$FISCAVA_TOKEN_FILE"`; recreate with `chmod 600` (step 3), or re-run `fiscava auth login`                   |
| `401 Unauthorized`                                     | Token expired or revoked                                                                | Re-run `fiscava auth login`; for an agent token, mint a fresh PAT (step 3) and replace the token file               |
| `403 Forbidden` on a specific command                  | Token's scopes don't include what the command needs                                     | `fiscava auth token revoke <id>`, then re-create with the missing scope (step 3)                                    |
| `403` with `details.reason: "tier_free"`               | Token owner is on FREE tier; the CLI is gated to PRO                                    | Upgrade at the URL in `details.upgradeUrl`. The token doesn't need re-issuing — the gate re-checks per call         |
| `403` with `details.reason: "past_due_grace_exceeded"` | Owner's PRO subscription went `past_due` 21+ days ago                                   | Resolve billing (Stripe / in-app `/settings/subscription`). Access resumes on the next call after status flips back |
| `403` with `details.reason: "subscription_cancelled"`  | Owner cancelled PRO                                                                     | Re-subscribe; the existing token works again on the next call (tokens aren't revoked on downgrade)                  |
| `exit code 2 — local usage error`                      | Bad arg or missing required flag                                                        | Re-read `fiscava <command> --help`; flags differ between read and write commands                                    |
| OpenClaw says "tool fiscava_X not found"               | MCP config didn't reload, or the binary path is wrong                                   | Reload OpenClaw; confirm the path matches `which fiscava`                                                           |
| Hook runs but stdout is empty in the agent context     | Hook reads stderr, or its timeout is shorter than command latency                       | Check OpenClaw's hook timeout; JSON is on stdout by default (only diagnostics go to stderr)                         |

### Exit code contract

`fiscava` follows a fixed exit code contract so hooks and CI can branch:

- `0` — success
- `1` — API returned an error (network, 4xx, 5xx)
- `2` — local usage / config error (bad flag, missing payload file, malformed JSON)
- `3` — authentication failed

---

## Day-2 operations

**Rotate the agent token** — every 30 days for `--expires 30d`, or sooner if its scopes change. This
reuses your logged-in session (no browser JWT):

```bash
fiscava auth login --email you@example.com   # if your session has expired
fiscava auth token list                      # find the active token id
fiscava auth token revoke <id>               # revoke the old one
fiscava auth token create --name "Claude Code" --scopes ... --expires 30d
# copy the new fcv_pat_ into the agent token file (step 3)
```

**Upgrade the CLI** when new commands or fixes ship:

```bash
npm install -g @fiscava/cli@latest
```

Token files and OpenClaw config are untouched by an upgrade — reload OpenClaw and you're done.

---

## Pointers

- [docs/FISCAVACLI.md](./FISCAVACLI.md) — full command reference, auth model, output contract,
  write-command guards.
- [apps/api/models/CliToken.types.ts](../apps/api/models/CliToken.types.ts) — authoritative scope
  list.
- <https://docs.openclaw.ai/cli/mcp> — OpenClaw's MCP config schema (external).
- <https://docs.openclaw.ai/tools/acp-agents> — OpenClaw's ACP harness model (external).
