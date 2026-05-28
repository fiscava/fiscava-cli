import { FiscavaApiClient, FiscavaApiError } from './apiClient';
import { CliConfig, writeTokenFile } from './config';
import { promptSecret, promptText } from './prompts';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';

type CommandContext = {
  client: FiscavaApiClient;
  config: CliConfig;
  args: string[];
  flags: Record<string, string | boolean>;
};

type Command = {
  path: string;
  method?: 'GET';
  queryFlags?: string[];
  // Maps a CLI flag name (kebab-case) to the query-string key the API
  // expects (often camelCase). Used when the API param doesn't match
  // the CLI flag name verbatim — e.g. --min-amount → ?minAmount=...
  // If a flag in queryFlags isn't in queryFlagMap, the flag name is
  // used as the query key as-is (preserves existing behaviour).
  queryFlagMap?: Record<string, string>;
};

const commands: Record<string, Command> = {
  'profile get': { path: '/api/auth/profile' },
  'usage get': { path: '/api/auth/usage' },
  'expenses list': {
    path: '/api/expenses',
    queryFlags: [
      'from',
      'to',
      'category',
      'payment-method',
      'limit',
      'page',
      'fields',
      'search',
      'min-amount',
      'max-amount',
    ],
    queryFlagMap: {
      'min-amount': 'minAmount',
      'max-amount': 'maxAmount',
    },
  },
  'expenses create': {
    path: '/api/expenses',
  },
  'expenses update': {
    path: '/api/expenses',
  },
  'expenses delete': {
    path: '/api/expenses',
  },
  'recurring list': {
    path: '/api/recurring',
    queryFlags: ['limit', 'page', 'fields'],
  },
  'recurring create': {
    path: '/api/recurring',
  },
  'recurring update': {
    path: '/api/recurring',
  },
  'recurring delete': {
    path: '/api/recurring',
  },
  'recurring complete': {
    path: '/api/recurring',
  },
  'recurring skip': {
    path: '/api/recurring',
  },
  'recurring toggle': {
    path: '/api/recurring',
  },
  'recurring pause': {
    path: '/api/recurring',
  },
  'recurring resume': {
    path: '/api/recurring',
  },
  'income transactions list': {
    path: '/api/income-transactions',
    queryFlags: [
      'from',
      'to',
      'status',
      'limit',
      'page',
      'fields',
      'search',
      'min-amount',
      'max-amount',
    ],
    queryFlagMap: {
      'min-amount': 'minAmount',
      'max-amount': 'maxAmount',
    },
  },
  'income transactions create': {
    path: '/api/income-transactions',
  },
  'income transactions update': {
    path: '/api/income-transactions',
  },
  'income transactions delete': {
    path: '/api/income-transactions',
  },
  'income summary': {
    path: '/api/income-transactions/summary',
    queryFlags: ['from', 'to', 'fields'],
  },
  'transfers list': {
    path: '/api/transfers',
    queryFlags: ['limit', 'page', 'fields'],
  },
  'transfers create': {
    path: '/api/transfers',
  },
  'transfers update': {
    path: '/api/transfers',
  },
  'transfers delete': {
    path: '/api/transfers',
  },
  'accounts list': {
    path: '/api/payment-methods',
    queryFlags: ['limit', 'page', 'fields'],
  },
  'debts list': {
    path: '/api/debts/accounts',
    queryFlags: ['limit', 'page', 'fields'],
  },
  'savings-goals list': {
    path: '/api/goals/savings',
    queryFlags: ['limit', 'page', 'fields'],
  },
  'networth summary': { path: '/api/networth/summary', queryFlags: ['fields'] },
  'portfolio summary': {
    path: '/api/portfolio/summary',
    queryFlags: ['fields'],
  },
  'export all': { path: '/api/export/all/json', queryFlags: ['format'] },
};

export function usage(): string {
  return `Usage: fiscava [--api-url URL] [--token TOKEN|--token-file FILE] [--format json|table|ndjson] <command>

Commands:
  auth status
  auth login --email EMAIL [--code 123456]
  auth token create --name NAME --scopes scope[,scope] [--expires 30d] [--session-token JWT]
  auth token list --session-token JWT
  auth token revoke ID --session-token JWT
  profile get
  usage get
  expenses list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N] [--search TEXT] [--min-amount N] [--max-amount N]
  expenses create --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--allow-duplicate] [--dry-run]
  expenses update ID --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--dry-run]
  expenses delete ID --yes [--idempotency-key KEY] [--dry-run]
  recurring list
  recurring create --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--allow-similar] [--dry-run]
  recurring update ID --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--dry-run]
  recurring delete ID --yes [--idempotency-key KEY] [--dry-run]
  recurring complete ID --yes (--payload @file.json|--payload -|--payload-json '{"paidAt":"YYYY-MM-DD","amount":N,"notes":"..."}') [--idempotency-key KEY] [--dry-run]
  recurring skip ID --yes (--payload @file.json|--payload -|--payload-json '{"skippedDate":"YYYY-MM-DD","reason":"..."}') [--idempotency-key KEY] [--dry-run]
  recurring pause ID --yes [--dry-run]
  recurring resume ID --yes [--dry-run]
  recurring toggle ID --yes [--dry-run]  (legacy; prefer pause/resume — toggle flips and is non-idempotent)
  income transactions list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--status paid] [--search TEXT] [--min-amount N] [--max-amount N]
  income transactions create --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--dry-run]
  income transactions update ID --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--dry-run]
  income transactions delete ID --yes [--idempotency-key KEY] [--dry-run]
  income summary [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  transfers list [--limit N] [--page N]
  transfers create --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--dry-run]
  transfers update ID --yes (--payload @file.json|--payload -|--payload-json '{"..."}') [--idempotency-key KEY] [--dry-run]
  transfers delete ID --yes [--idempotency-key KEY] [--dry-run]
  accounts list
  debts list
  savings-goals list
  networth summary
  portfolio summary
  export all --format json
`;
}

export async function runCommand(context: CommandContext): Promise<unknown> {
  const key = findCommandKey(context.args);

  if (key === 'auth status') {
    return {
      authenticated: Boolean(context.config.token),
      apiUrl: context.config.apiUrl,
      tokenSource: context.config.token
        ? context.flags['token']
          ? 'flag'
          : context.config.tokenFile
            ? 'token-file-or-env'
            : 'env'
        : 'none',
    };
  }

  if (key === 'auth login') {
    return login(context);
  }

  if (key === 'auth token create') {
    const name = requireFlag(context.flags, 'name');
    const scopes = requireFlag(context.flags, 'scopes');
    const sessionToken = requireSessionToken(context.flags);
    const client = new FiscavaApiClient({
      apiUrl: context.config.apiUrl,
      token: sessionToken,
    });

    return client.post('/api/auth/cli-tokens', {
      name,
      scopes: scopes
        .split(',')
        .map(scope => scope.trim())
        .filter(Boolean),
      expires: stringFlag(context.flags, 'expires'),
    });
  }

  if (key === 'auth token list') {
    const sessionToken = requireSessionToken(context.flags);
    const client = new FiscavaApiClient({
      apiUrl: context.config.apiUrl,
      token: sessionToken,
    });

    return client.get('/api/auth/cli-tokens');
  }

  if (key === 'auth token revoke') {
    const id = context.args[3];

    if (!id) {
      throw new Error('auth token revoke requires a token id');
    }

    const sessionToken = requireSessionToken(context.flags);
    const client = new FiscavaApiClient({
      apiUrl: context.config.apiUrl,
      token: sessionToken,
    });

    return client.delete(`/api/auth/cli-tokens/${encodeURIComponent(id)}`);
  }

  if (key === 'expenses create') {
    return createExpense(context);
  }

  if (key === 'expenses update') {
    return updateResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-expense-update',
      basePath: '/api/expenses',
    });
  }

  if (key === 'expenses delete') {
    return deleteResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-expense-delete',
      basePath: '/api/expenses',
    });
  }

  if (key === 'income transactions create') {
    return createJsonWrite(context, {
      idempotencyKeyPrefix: 'fiscava-income-transaction-create',
      path: '/api/income-transactions',
    });
  }

  if (key === 'income transactions update') {
    return updateResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-income-transaction-update',
      basePath: '/api/income-transactions',
    });
  }

  if (key === 'income transactions delete') {
    return deleteResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-income-transaction-delete',
      basePath: '/api/income-transactions',
    });
  }

  if (key === 'recurring create') {
    return createJsonWrite(context, {
      idempotencyKeyPrefix: 'fiscava-recurring-create',
      path: '/api/recurring',
      preparePayload: payload =>
        context.flags['allow-similar'] === true
          ? { ...payload, ignoreDuplicates: true }
          : payload,
    });
  }

  if (key === 'recurring update') {
    // 7.13: server now honours Idempotency-Key for this route via the V7
    // idempotency module (recurring_template_update event type). Re-add
    // the header; a retry returns the cached payment state without
    // re-applying the patch.
    return updateResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-recurring-update',
      basePath: '/api/recurring',
    });
  }

  if (key === 'recurring delete') {
    // 7.13: server now honours Idempotency-Key (recurring_template_delete
    // event type). A retry after an ambiguous timeout returns 200 (no-op)
    // instead of 404. Security: the (userId, contractName, key) triple
    // means only the user who originally deleted with that key gets the
    // no-op — other users still 404.
    return deleteResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-recurring-delete',
      basePath: '/api/recurring',
    });
  }

  if (key === 'recurring complete') {
    return instanceAction(context, key, {
      idempotencyKeyPrefix: 'fiscava-recurring-complete',
      basePath: '/api/recurring',
      action: 'complete',
      method: 'POST',
    });
  }

  if (key === 'recurring skip') {
    // 7.13: server now honours Idempotency-Key for skip via the V7
    // idempotency module (recurring_skip event type). A retry returns
    // the cached payment state without re-advancing nextDueDate or
    // adding another history entry.
    return instanceAction(context, key, {
      idempotencyKeyPrefix: 'fiscava-recurring-skip',
      basePath: '/api/recurring',
      action: 'skip',
      method: 'POST',
    });
  }

  if (key === 'recurring pause') {
    // 7.13: pause = setStatus(isActive=false). Naturally idempotent —
    // pausing twice leaves the doc paused. Server-side: PATCH /:id/status
    // with body {isActive: false}. No idempotency-record machinery needed.
    return setRecurringStatus(context, key, false);
  }

  if (key === 'recurring resume') {
    return setRecurringStatus(context, key, true);
  }

  if (key === 'recurring toggle') {
    // Legacy: toggle FLIPS isActive (non-idempotent). 7.13 introduced
    // `recurring pause` / `recurring resume` which use the new
    // PATCH /:id/status endpoint with explicit state — those are
    // retry-safe by design. Keeping toggle for backwards compat.
    return instanceAction(context, key, {
      idempotencyKeyPrefix: 'fiscava-recurring-toggle',
      basePath: '/api/recurring',
      action: 'toggle',
      method: 'PATCH',
      payloadOptional: true,
      omitIdempotencyKey: true,
    });
  }

  if (key === 'transfers create') {
    return createJsonWrite(context, {
      idempotencyKeyPrefix: 'fiscava-transfer-create',
      path: '/api/transfers',
    });
  }

  if (key === 'transfers update') {
    return updateResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-transfer-update',
      basePath: '/api/transfers',
    });
  }

  if (key === 'transfers delete') {
    return deleteResource(context, key, {
      idempotencyKeyPrefix: 'fiscava-transfer-delete',
      basePath: '/api/transfers',
    });
  }

  const command = commands[key];

  if (!command) {
    throw new Error(`Unknown command: ${context.args.join(' ')}`);
  }

  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  const query = Object.fromEntries(
    (command.queryFlags ?? []).map(flag => [
      command.queryFlagMap?.[flag] ?? flag,
      stringFlag(context.flags, flag),
    ])
  );

  return context.client.get(command.path, query);
}

type JsonObject = Record<string, unknown>;

type DuplicateCheckResult = {
  isDuplicate?: boolean;
  duplicate?: unknown;
  matchType?: string;
};

async function createExpense(context: CommandContext): Promise<unknown> {
  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  requireWriteConfirmation(context.flags);

  const payload = await readJsonPayload(context.flags);
  const idempotencyKey = resolveIdempotencyKey(
    context.flags,
    'fiscava-expense-create'
  );
  const allowDuplicate = context.flags['allow-duplicate'] === true;
  const dryRun = context.flags['dry-run'] === true;
  let duplicateCheck: DuplicateCheckResult | null = null;

  if (!allowDuplicate) {
    duplicateCheck = await context.client.post<DuplicateCheckResult>(
      '/api/expenses/check-duplicate',
      buildDuplicateCheckPayload(payload)
    );

    if (duplicateCheck.isDuplicate && !dryRun) {
      throw new FiscavaApiError({
        code: 'DUPLICATE_BLOCKED',
        message:
          'Potential duplicate expense detected. Re-run with --allow-duplicate to bypass.',
        status: 409,
        details: duplicateCheck,
      });
    }
  }

  if (dryRun) {
    return {
      idempotencyKey,
      dryRun: true,
      payload,
      duplicateCheck,
      duplicateCheckSkipped: allowDuplicate,
    };
  }

  const result = await context.client.post('/api/expenses', payload, {
    'Idempotency-Key': idempotencyKey,
  });

  return {
    idempotencyKey,
    dryRun: false,
    result,
  };
}

type JsonWriteOptions = {
  path: string;
  idempotencyKeyPrefix: string;
  preparePayload?: (payload: JsonObject) => JsonObject;
};

type UpdateResourceOptions = {
  basePath: string;
  idempotencyKeyPrefix: string;
  // When true, the CLI does NOT send the Idempotency-Key header and
  // does not surface an idempotencyKey in the response shape. Use for
  // server-side routes that do not honour the header (e.g. recurring
  // update — see routes/recurring/handlers/mutations.ts). Advertising
  // a key the server ignores is a false retry-safety promise. Mirrors
  // the omitIdempotencyKey option on InstanceActionOptions.
  omitIdempotencyKey?: boolean;
};

// Update helper for resources where update = PUT /api/<resource>/:id with a
// JSON body. Mirrors createJsonWrite's shape (--yes confirmation,
// --payload sources, --idempotency-key, --dry-run) so agents and humans
// can use the same flag vocabulary across create and update commands.
async function updateResource(
  context: CommandContext,
  commandKey: string,
  options: UpdateResourceOptions
): Promise<unknown> {
  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  const id = extractResourceId(context.args, commandKey);

  requireWriteConfirmation(context.flags);

  const payload = await readJsonPayload(context.flags);
  const dryRun = context.flags['dry-run'] === true;
  const idempotencyKey = options.omitIdempotencyKey
    ? null
    : resolveIdempotencyKey(context.flags, options.idempotencyKeyPrefix);

  if (dryRun) {
    return {
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      dryRun: true,
      id,
      payload,
    };
  }

  const headers: Record<string, string> =
    idempotencyKey !== null ? { 'Idempotency-Key': idempotencyKey } : {};
  const result = await context.client.put(
    `${options.basePath}/${encodeURIComponent(id)}`,
    payload,
    headers
  );

  return {
    ...(idempotencyKey !== null ? { idempotencyKey } : {}),
    dryRun: false,
    id,
    result,
  };
}

type DeleteResourceOptions = {
  basePath: string;
  idempotencyKeyPrefix: string;
  // Same semantics as UpdateResourceOptions.omitIdempotencyKey — used
  // for routes where the server does not honour the header (recurring
  // delete does not forward Idempotency-Key to its service).
  omitIdempotencyKey?: boolean;
};

// Delete helper. Carries an Idempotency-Key on the DELETE so agent retries
// after a transient network error dedupe server-side instead of
// double-deleting (no-op the second time, but the agent would see a 404
// it can't distinguish from "already gone" vs "never existed").
// EXCEPT when omitIdempotencyKey is set — see the option docstring.
async function deleteResource(
  context: CommandContext,
  commandKey: string,
  options: DeleteResourceOptions
): Promise<unknown> {
  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  const id = extractResourceId(context.args, commandKey);

  requireWriteConfirmation(context.flags);

  const dryRun = context.flags['dry-run'] === true;
  const idempotencyKey = options.omitIdempotencyKey
    ? null
    : resolveIdempotencyKey(context.flags, options.idempotencyKeyPrefix);

  if (dryRun) {
    return {
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      dryRun: true,
      id,
    };
  }

  const headers: Record<string, string> =
    idempotencyKey !== null ? { 'Idempotency-Key': idempotencyKey } : {};
  const result = await context.client.delete(
    `${options.basePath}/${encodeURIComponent(id)}`,
    headers
  );

  return {
    ...(idempotencyKey !== null ? { idempotencyKey } : {}),
    dryRun: false,
    id,
    result,
  };
}

type InstanceActionOptions = {
  basePath: string;
  action: string;
  method: 'POST' | 'PATCH';
  idempotencyKeyPrefix: string;
  // When true, the command may run without --payload (e.g. recurring
  // toggle has no body). When false, --payload is required like the
  // create/update commands.
  payloadOptional?: boolean;
  // When true, the CLI does NOT send the Idempotency-Key header and
  // does not surface an idempotencyKey in the response shape. Use for
  // server-side actions that do not implement idempotency, where
  // advertising the header would be a false retry-safety promise
  // (worse than offering nothing because agents would write retry
  // logic against it). e.g. recurring skip and toggle as of 7.12.
  omitIdempotencyKey?: boolean;
};

// Helper for per-instance recurring ops: POST /:id/<action> or
// PATCH /:id/<action>. Currently used for complete, skip, toggle.
// Payload is optional for actions like toggle (the server flips state
// without a body); required for actions like complete that need a date.
async function instanceAction(
  context: CommandContext,
  commandKey: string,
  options: InstanceActionOptions
): Promise<unknown> {
  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  const id = extractResourceId(context.args, commandKey);

  requireWriteConfirmation(context.flags);

  const hasPayloadFlag = Boolean(
    stringFlag(context.flags, 'payload') ??
    stringFlag(context.flags, 'payload-json')
  );
  const payload =
    options.payloadOptional && !hasPayloadFlag
      ? {}
      : await readJsonPayload(context.flags);
  const dryRun = context.flags['dry-run'] === true;
  // Don't compute/send an Idempotency-Key for actions whose server-side
  // handler doesn't honour one (currently skip and toggle) — see the
  // omitIdempotencyKey docstring on InstanceActionOptions.
  const idempotencyKey = options.omitIdempotencyKey
    ? null
    : resolveIdempotencyKey(context.flags, options.idempotencyKeyPrefix);

  if (dryRun) {
    return {
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      dryRun: true,
      id,
      action: options.action,
      payload,
    };
  }

  const path = `${options.basePath}/${encodeURIComponent(id)}/${options.action}`;
  const headers: Record<string, string> =
    idempotencyKey !== null ? { 'Idempotency-Key': idempotencyKey } : {};
  const result =
    options.method === 'PATCH'
      ? await context.client.patch(path, payload, headers)
      : await context.client.post(path, payload, headers);

  return {
    ...(idempotencyKey !== null ? { idempotencyKey } : {}),
    dryRun: false,
    id,
    action: options.action,
    result,
  };
}

// 7.13: pause/resume helper. Hits the new PATCH /api/recurring/:id/status
// endpoint with body {isActive: boolean}. Naturally idempotent (setting
// to X twice yields X), so no --idempotency-key surface. --yes required
// (write op); --dry-run supported.
async function setRecurringStatus(
  context: CommandContext,
  commandKey: string,
  isActive: boolean
): Promise<unknown> {
  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  const id = extractResourceId(context.args, commandKey);

  requireWriteConfirmation(context.flags);

  const dryRun = context.flags['dry-run'] === true;
  const action = isActive ? 'resume' : 'pause';

  if (dryRun) {
    return {
      dryRun: true,
      id,
      action,
      payload: { isActive },
    };
  }

  const result = await context.client.patch(
    `/api/recurring/${encodeURIComponent(id)}/status`,
    { isActive }
  );

  return {
    dryRun: false,
    id,
    action,
    result,
  };
}

// Resource id is the positional arg immediately following the command
// verb path. For `expenses update abc-123` commandKey is 'expenses update'
// (2 words) so id is at args[2]; for `income transactions update abc-123`
// commandKey is 'income transactions update' (3 words) so id is at
// args[3]. Deriving the position from the command key — not just taking
// the last arg — prevents `<resource> delete` (no id) from being silently
// accepted with the verb itself ("delete") used as the id.
function extractResourceId(args: string[], commandKey: string): string {
  const idIndex = commandKey.split(' ').length;
  const id = args[idIndex];

  if (!id || id.startsWith('-')) {
    throw new Error('Resource id is required as the last positional argument.');
  }

  return id;
}

async function createJsonWrite(
  context: CommandContext,
  options: JsonWriteOptions
): Promise<unknown> {
  if (!context.config.token) {
    throw new Error(
      'Authentication required. Set FISCAVA_TOKEN or --token-file.'
    );
  }

  requireWriteConfirmation(context.flags);

  const rawPayload = await readJsonPayload(context.flags);
  const payload = options.preparePayload?.(rawPayload) ?? rawPayload;
  const idempotencyKey = resolveIdempotencyKey(
    context.flags,
    options.idempotencyKeyPrefix
  );
  const dryRun = context.flags['dry-run'] === true;

  if (dryRun) {
    return {
      idempotencyKey,
      dryRun: true,
      payload,
    };
  }

  const result = await context.client.post(options.path, payload, {
    'Idempotency-Key': idempotencyKey,
  });

  return {
    idempotencyKey,
    dryRun: false,
    result,
  };
}

function findCommandKey(args: string[]): string {
  const candidates = [args.slice(0, 4), args.slice(0, 3), args.slice(0, 2)].map(
    parts => parts.join(' ')
  );

  return (
    candidates.find(
      candidate => candidate in commands || candidate.startsWith('auth ')
    ) ?? ''
  );
}

function stringFlag(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function requireWriteConfirmation(
  flags: Record<string, string | boolean>
): void {
  if (flags['yes'] !== true) {
    throw new Error('Write commands require --yes.');
  }
}

async function readJsonPayload(
  flags: Record<string, string | boolean>
): Promise<JsonObject> {
  const payloadArg = stringFlag(flags, 'payload');
  const payloadJsonArg = stringFlag(flags, 'payload-json');

  if (Boolean(payloadArg) === Boolean(payloadJsonArg)) {
    throw new Error(
      'Provide exactly one payload source: --payload @file.json|--payload -|--payload-json \'{"..."}\'.'
    );
  }

  if (payloadJsonArg) {
    return parseJsonObject(payloadJsonArg, '--payload-json');
  }

  if (!payloadArg) {
    throw new Error(
      'Provide exactly one payload source: --payload @file.json|--payload -|--payload-json \'{"..."}\'.'
    );
  }

  if (payloadArg === '-') {
    const text = await readFromStdin();
    return parseJsonObject(text, '--payload -');
  }

  if (!payloadArg.startsWith('@') || payloadArg.length <= 1) {
    throw new Error('--payload must be either @<file.json> or - for stdin.');
  }

  const filePath = payloadArg.slice(1);

  try {
    const fileText = await readFile(filePath, 'utf8');
    return parseJsonObject(fileText, `--payload ${payloadArg}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to read payload file';
    throw new Error(`Failed to read payload file "${filePath}": ${message}`);
  }
}

async function readFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('--payload - requires JSON input from stdin.');
  }

  let buffer = '';

  for await (const chunk of process.stdin) {
    buffer += chunk;
  }

  if (buffer.trim().length === 0) {
    throw new Error('--payload - received empty input.');
  }

  return buffer;
}

function parseJsonObject(raw: string, source: string): JsonObject {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isJsonObject(parsed)) {
      throw new Error(`${source} must be a JSON object.`);
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes(source)) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : 'Invalid JSON payload';
    throw new Error(`${source} must contain valid JSON: ${message}`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildDuplicateCheckPayload(payload: JsonObject): JsonObject {
  const fields = [
    'amount',
    'date',
    'description',
    'storeId',
    'categoryId',
    'paymentMethodId',
  ] as const;

  return Object.fromEntries(
    fields
      .filter(field => payload[field] !== undefined)
      .map(field => [field, payload[field]])
  );
}

function resolveIdempotencyKey(
  flags: Record<string, string | boolean>,
  prefix: string
): string {
  const provided = stringFlag(flags, 'idempotency-key')?.trim();

  if (provided) {
    return provided;
  }

  return `${prefix}-${randomUUID()}`;
}

function requireFlag(
  flags: Record<string, string | boolean>,
  name: string
): string {
  const value = stringFlag(flags, name);

  if (!value) {
    throw new Error(`--${name} is required`);
  }

  return value;
}

function requireSessionToken(flags: Record<string, string | boolean>): string {
  return (
    stringFlag(flags, 'session-token') ??
    process.env['FISCAVA_SESSION_TOKEN'] ??
    requireFlag(flags, 'token')
  );
}

type LoginSuccess = {
  user?: {
    email?: string;
  };
  token: string;
};

type LoginRequiresTwoFactor = {
  requires2FA: true;
  tempToken: string;
};

type LoginResult = LoginSuccess | LoginRequiresTwoFactor;

function requiresTwoFactor(
  result: LoginResult
): result is LoginRequiresTwoFactor {
  return 'requires2FA' in result && result.requires2FA === true;
}

async function login(context: CommandContext): Promise<unknown> {
  const email =
    stringFlag(context.flags, 'email') ?? (await promptText('Email'));
  const password = await promptSecret('Password');
  const rememberMe = context.flags['no-remember'] !== true;
  const loginResult = await context.client.post<LoginResult>(
    '/api/auth/login',
    {
      email,
      password,
      rememberMe,
    }
  );
  const success = requiresTwoFactor(loginResult)
    ? await completeTwoFactorLogin(context, loginResult, rememberMe)
    : loginResult;

  if (!context.config.tokenFile) {
    throw new Error('Token file path could not be resolved');
  }

  writeTokenFile(context.config.tokenFile, success.token);

  return {
    authenticated: true,
    apiUrl: context.config.apiUrl,
    email: success.user?.email ?? email,
    tokenFile: context.config.tokenFile,
  };
}

async function completeTwoFactorLogin(
  context: CommandContext,
  loginResult: LoginRequiresTwoFactor,
  rememberMe: boolean
): Promise<LoginSuccess> {
  const code =
    stringFlag(context.flags, 'code') ??
    stringFlag(context.flags, 'two-factor-code') ??
    (await promptText('2FA code'));

  return context.client.post<LoginSuccess>('/api/auth/2fa/verify', {
    code,
    rememberMe,
    tempToken: loginResult.tempToken,
  });
}
