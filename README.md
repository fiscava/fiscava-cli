# @fiscava/cli

**Manage your personal finances from the terminal — and give your AI agents safe, scoped access to
your money data.**

`@fiscava/cli` (command: `fiscava`) is the official command-line interface for
[Fiscava](https://fiscava.app). Track expenses, income, recurring bills, and net worth from your
shell, or wire it into an AI coding agent (Claude Code, OpenClaw, Cursor) so it can read and act on
your finances through revocable, scoped tokens — never your password.

It's a thin, dependency-free HTTP client over the same API the Fiscava web app uses. It does not
touch your browser storage, local files, or any database directly.

## Install

```bash
npm install -g @fiscava/cli
```

Requires Node.js 20+ and a [Fiscava](https://fiscava.app) **PRO** subscription (CLI access is a PRO
feature).

## Quick start

```bash
# Sign in (prompts for email, password, 2FA — stores only the returned token)
fiscava auth login --email you@example.com

# Read your data
fiscava expenses list --from 2026-01-01 --to 2026-01-31 --limit 50
fiscava income summary --from 2026-01-01 --to 2026-01-31
fiscava networth summary

# Machine-friendly output for scripts and agents
fiscava expenses list --format ndjson --fields date,amount,merchant
```

## What You Can Do

`@fiscava/cli` covers both read access and guarded write operations across the main Fiscava finance
surfaces:

- expenses: list, create, update, delete
- income: transaction list, create, update, delete, plus summary views
- recurring: list, create, update, delete, complete, skip, pause, resume
- transfers: list, create, update, delete
- accounts and liabilities: accounts list, debts list, savings-goals list
- wealth views: net worth summary, portfolio summary
- profile and usage: profile get, usage get
- exports: full JSON export for agent-friendly backups and analysis
- auth administration: token create, list, revoke

The npm page is intentionally short, but the CLI itself is not read-only.

## Use it with AI agents

The CLI is built for agent runtimes. Create a **scoped, revocable** personal access token, drop it
in a `0600` file, and point your agent at the binary — it gets exactly the access you grant, nothing
more:

```bash
fiscava auth token create \
  --name "Claude Code" \
  --scopes profile:read,expenses:read,recurring:read,networth:read \
  --expires 30d
```

Then any agent that can run a shell command can query your finances. See the
[OpenClaw getting-started guide](https://github.com/fiscava/fiscava-cli/blob/main/docs/FISCAVACLI_OPENCLAW_GETTING_STARTED.md)
for MCP server, slash-command, and hook integration patterns.

## Authentication

The CLI never stores your password. Authenticate one of two ways:

1. **Session login** (`fiscava auth login`) — prompts for email, password, and 2FA, stores only the
   returned token.
2. **Personal access token** (`fiscava auth token create`) — scoped and expiring, for agent runtimes
   and automation.

Tokens live in a `0600` file you control. Subscription state is re-checked on every request, so a
token grants access only while your PRO subscription is active.

## Safe Writes For Automation

Write commands are built for agent and script safety rather than raw shell convenience:

- `--yes` is required for non-interactive writes
- `--dry-run` lets automation validate payloads before mutating data
- `--idempotency-key` protects retries from accidental duplicate creates
- duplicate and similar-item guards stay on by default unless explicitly bypassed
- payloads can come from files, stdin, or inline JSON

Example guarded writes:

```bash
fiscava expenses create --yes --payload @expense.json --dry-run
fiscava recurring create --yes --payload @recurring.json
fiscava income transactions create --yes --payload @income.json
fiscava transfers create --yes --payload @transfer.json
fiscava recurring complete rec_123 --yes --payload-json '{"paidAt":"2026-06-01","amount":42.50}'
```

## Output contract

- JSON on stdout (default); diagnostics and structured errors on stderr.
- Exit codes: `0` success, `1` API error, `2` usage/config error, `3` auth failure.
- `--format ndjson` for line-oriented streaming; `--fields a,b,c` to trim payloads for agent context
  windows.

## Common commands

```bash
fiscava auth status
fiscava auth token list
fiscava profile get
fiscava usage get
fiscava expenses list --from 2026-01-01 --to 2026-01-31 --limit 50
fiscava expenses create --yes --payload @expense.json
fiscava income transactions list --status received
fiscava income transactions create --yes --payload @income.json
fiscava recurring list
fiscava recurring pause rec_123 --yes
fiscava recurring complete rec_123 --yes --payload @complete.json
fiscava transfers list
fiscava transfers create --yes --payload @transfer.json
fiscava accounts list
fiscava debts list
fiscava savings-goals list
fiscava networth summary
fiscava portfolio summary
fiscava export all --format json
```

Full command reference, scope list, and write-command guards:
[FISCAVACLI.md](https://github.com/fiscava/fiscava-cli/blob/main/docs/FISCAVACLI.md).

## License

[MIT](./LICENSE) © Fiscava
