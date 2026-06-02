import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FiscavaApiClient, FiscavaApiError } from '../apiClient';
import { requireSessionToken, runCommand } from '../commands';
import { CliConfig, PRODUCTION_API_URL, resolveConfig } from '../config';
import { resolveCliFailure } from '../errorHandling';
import { selectFields } from '../output';

describe('output helpers', () => {
  it('selects requested fields from arrays for token-light agent output', () => {
    expect(
      selectFields(
        [{ id: '1', amount: 10, notes: 'private' }],
        ['id', 'amount']
      )
    ).toEqual([{ id: '1', amount: 10 }]);
  });
});

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function createMockClient(): MockClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

function createConfig(token = 'fcv_pat_token'): CliConfig {
  return {
    apiUrl: 'http://localhost:4000',
    token,
    tokenFile: '/tmp/fiscava-token',
    format: 'json',
  };
}

async function runCliCommand({
  client = createMockClient(),
  flags = {},
  args = ['expenses', 'create'],
  token = 'fcv_pat_token',
}: {
  client?: MockClient;
  flags?: Record<string, string | boolean>;
  args?: string[];
  token?: string;
}) {
  const result = await runCommand({
    client: client as unknown as FiscavaApiClient,
    config: createConfig(token),
    args,
    flags,
  });

  return { result, client };
}

async function runExpenseCreate(options: Parameters<typeof runCliCommand>[0]) {
  return runCliCommand({
    ...options,
    args: options.args ?? ['expenses', 'create'],
  });
}

describe('expenses create command', () => {
  it('requires --yes for write commands', async () => {
    await expect(
      runExpenseCreate({
        flags: {
          'payload-json': JSON.stringify({ amount: 20, date: '2026-05-10' }),
        },
      })
    ).rejects.toThrow('Write commands require --yes.');
  });

  it('requires exactly one payload source', async () => {
    await expect(
      runExpenseCreate({
        flags: { yes: true },
      })
    ).rejects.toThrow('Provide exactly one payload source');

    await expect(
      runExpenseCreate({
        flags: {
          yes: true,
          payload: '@/tmp/input.json',
          'payload-json': '{}',
        },
      })
    ).rejects.toThrow('Provide exactly one payload source');
  });

  it('loads payload from --payload @file.json', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fiscavacli-expense-'));
    const payloadPath = join(tempDir, 'payload.json');
    const payload = {
      amount: 25,
      date: '2026-05-10',
      description: 'Lunch',
      categoryId: '507f1f77bcf86cd799439011',
      paymentMethodId: '507f1f77bcf86cd799439012',
    };
    const client = createMockClient();
    client.post.mockResolvedValueOnce({ isDuplicate: false });
    client.post.mockResolvedValueOnce({ id: 'expense-1' });
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    try {
      const { result } = await runExpenseCreate({
        client,
        flags: {
          yes: true,
          payload: `@${payloadPath}`,
          'idempotency-key': 'exp-file-key',
        },
      });

      expect(client.post).toHaveBeenNthCalledWith(
        1,
        '/api/expenses/check-duplicate',
        {
          amount: 25,
          date: '2026-05-10',
          description: 'Lunch',
          categoryId: '507f1f77bcf86cd799439011',
          paymentMethodId: '507f1f77bcf86cd799439012',
        }
      );
      expect(client.post).toHaveBeenNthCalledWith(2, '/api/expenses', payload, {
        'Idempotency-Key': 'exp-file-key',
      });
      expect(result).toEqual({
        idempotencyKey: 'exp-file-key',
        dryRun: false,
        result: { id: 'expense-1' },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('runs duplicate preflight and returns metadata on --dry-run', async () => {
    const client = createMockClient();
    client.post.mockResolvedValueOnce({
      isDuplicate: false,
      duplicate: null,
      matchType: 'none',
    });

    const { result } = await runExpenseCreate({
      client,
      flags: {
        yes: true,
        'dry-run': true,
        'payload-json': JSON.stringify({
          amount: 32,
          date: '2026-05-10',
          description: 'Taxi',
        }),
      },
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/api/expenses/check-duplicate',
      {
        amount: 32,
        date: '2026-05-10',
        description: 'Taxi',
      }
    );
    expect(result).toMatchObject({
      dryRun: true,
      duplicateCheckSkipped: false,
      payload: {
        amount: 32,
        date: '2026-05-10',
        description: 'Taxi',
      },
      duplicateCheck: {
        isDuplicate: false,
      },
    });
    expect((result as { idempotencyKey: string }).idempotencyKey).toContain(
      'fiscava-expense-create-'
    );
  });

  it('skips duplicate preflight when --allow-duplicate is set', async () => {
    const client = createMockClient();
    client.post.mockResolvedValueOnce({ id: 'expense-2' });

    const { result } = await runExpenseCreate({
      client,
      flags: {
        yes: true,
        'allow-duplicate': true,
        'payload-json': JSON.stringify({
          amount: 120,
          date: '2026-05-10',
        }),
        'idempotency-key': 'exp-allow-dup',
      },
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/api/expenses',
      {
        amount: 120,
        date: '2026-05-10',
      },
      {
        'Idempotency-Key': 'exp-allow-dup',
      }
    );
    expect(result).toEqual({
      idempotencyKey: 'exp-allow-dup',
      dryRun: false,
      result: { id: 'expense-2' },
    });
  });

  it('blocks create when duplicate is detected without --allow-duplicate', async () => {
    const client = createMockClient();
    client.post.mockResolvedValueOnce({
      isDuplicate: true,
      duplicate: { id: 'expense-existing' },
      matchType: 'exact',
    });

    const runPromise = runExpenseCreate({
      client,
      flags: {
        yes: true,
        'payload-json': JSON.stringify({
          amount: 85,
          date: '2026-05-10',
          description: 'Utilities',
        }),
      },
    });

    await expect(runPromise).rejects.toThrow(
      'Potential duplicate expense detected'
    );
    await expect(runPromise).rejects.toMatchObject({
      payload: {
        code: 'DUPLICATE_BLOCKED',
        status: 409,
        details: {
          isDuplicate: true,
          duplicate: { id: 'expense-existing' },
          matchType: 'exact',
        },
      },
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/api/expenses/check-duplicate',
      {
        amount: 85,
        date: '2026-05-10',
        description: 'Utilities',
      }
    );
  });
});

describe('import expenses commands', () => {
  it('plans an expense import by sending CSV content and mapping to the API', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fiscavacli-import-'));
    const csvPath = join(tempDir, 'statement.csv');
    const mappingPath = join(tempDir, 'mapping.json');
    const client = createMockClient();

    client.post.mockResolvedValueOnce({ planId: 'plan-1' });
    await writeFile(
      csvPath,
      'Date,Amount,Description,Payment\n2026-06-01,12.5,Lunch,Cash',
      'utf8'
    );
    await writeFile(
      mappingPath,
      JSON.stringify({
        date: 0,
        amount: 1,
        description: 2,
        paymentMethodName: 3,
      }),
      'utf8'
    );

    const { result } = await runCliCommand({
      client,
      args: ['import', 'expenses', 'plan'],
      flags: {
        file: csvPath,
        mapping: `@${mappingPath}`,
        'date-format': 'YYYY-MM-DD',
        'category-policy': 'require',
        'max-rows': '250',
      },
    });

    expect(result).toEqual({ planId: 'plan-1' });
    expect(client.post).toHaveBeenCalledWith(
      '/api/export/import/expenses/reconcile/plan',
      expect.objectContaining({
        source: expect.objectContaining({
          type: 'csv_text',
          fileName: csvPath,
          content: expect.stringContaining('Lunch'),
        }),
        mapping: {
          date: 0,
          amount: 1,
          description: 2,
          paymentMethodName: 3,
        },
        dateFormat: 'YYYY-MM-DD',
        hasHeaders: true,
        categoryPolicy: 'require',
        maxRows: 250,
      })
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires a commit token before calling the import commit API', async () => {
    const client = createMockClient();

    await expect(
      runCliCommand({
        client,
        args: ['import', 'expenses', 'commit'],
        flags: {
          'plan-id': 'plan-1',
          'decisions-json': '[]',
        },
      })
    ).rejects.toMatchObject({
      payload: {
        code: 'COMMIT_TOKEN_REQUIRED',
        status: 400,
      },
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('commits a planned expense import with token and decisions', async () => {
    const client = createMockClient();

    client.post.mockResolvedValueOnce({ commitId: 'commit-1' });

    const { result } = await runCliCommand({
      client,
      args: ['import', 'expenses', 'commit'],
      flags: {
        'plan-id': 'plan-1',
        'commit-token': 'token-1',
        'decisions-json':
          '[{"rowId":"row-1","rowNumber":1,"rowHash":"abc","action":"create_new"}]',
        'idempotency-key': 'idem-1',
      },
    });

    expect(result).toEqual({ commitId: 'commit-1' });
    expect(client.post).toHaveBeenCalledWith(
      '/api/export/import/expenses/reconcile/commit',
      {
        planId: 'plan-1',
        commitToken: 'token-1',
        idempotencyKey: 'idem-1',
        decisions: [
          {
            rowId: 'row-1',
            rowNumber: 1,
            rowHash: 'abc',
            action: 'create_new',
          },
        ],
      }
    );
  });
});

describe('income transactions create command', () => {
  it('posts payload with an idempotency key', async () => {
    const client = createMockClient();
    const payload = {
      type: 'one_time',
      category: 'salary',
      name: 'Bonus',
      amount: 250,
      date: '2026-05-10',
      paymentMethodId: '507f1f77bcf86cd799439012',
    };

    client.post.mockResolvedValueOnce({ id: 'income-1' });

    const { result } = await runCliCommand({
      client,
      args: ['income', 'transactions', 'create'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify(payload),
        'idempotency-key': 'income-key',
      },
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/income-transactions',
      payload,
      {
        'Idempotency-Key': 'income-key',
      }
    );
    expect(result).toEqual({
      idempotencyKey: 'income-key',
      dryRun: false,
      result: { id: 'income-1' },
    });
  });

  it('returns dry-run metadata without posting', async () => {
    const client = createMockClient();

    const { result } = await runCliCommand({
      client,
      args: ['income', 'transactions', 'create'],
      flags: {
        yes: true,
        'dry-run': true,
        'payload-json': JSON.stringify({
          type: 'one_time',
          category: 'salary',
          name: 'Bonus',
          amount: 250,
          date: '2026-05-10',
        }),
      },
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      payload: {
        type: 'one_time',
        category: 'salary',
        name: 'Bonus',
        amount: 250,
        date: '2026-05-10',
      },
    });
    expect((result as { idempotencyKey: string }).idempotencyKey).toContain(
      'fiscava-income-transaction-create-'
    );
  });
});

describe('recurring create command', () => {
  it('posts payload with an idempotency key', async () => {
    const client = createMockClient();
    const payload = {
      name: 'Rent',
      paymentType: 'expense',
      amount: 2400,
      frequency: 'monthly',
      startDate: '2026-05-10',
      categoryId: '507f1f77bcf86cd799439011',
      paymentMethodId: '507f1f77bcf86cd799439012',
      storeId: '507f1f77bcf86cd799439013',
    };

    client.post.mockResolvedValueOnce({ id: 'recurring-1' });

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'create'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify(payload),
        'idempotency-key': 'recurring-key',
      },
    });

    expect(client.post).toHaveBeenCalledWith('/api/recurring', payload, {
      'Idempotency-Key': 'recurring-key',
    });
    expect(result).toEqual({
      idempotencyKey: 'recurring-key',
      dryRun: false,
      result: { id: 'recurring-1' },
    });
  });

  it('maps --allow-similar to ignoreDuplicates', async () => {
    const client = createMockClient();

    client.post.mockResolvedValueOnce({ id: 'recurring-2' });

    await runCliCommand({
      client,
      args: ['recurring', 'create'],
      flags: {
        yes: true,
        'allow-similar': true,
        'payload-json': JSON.stringify({
          name: 'Rent',
          paymentType: 'expense',
          amount: 2400,
          frequency: 'monthly',
          startDate: '2026-05-10',
          categoryId: '507f1f77bcf86cd799439011',
          paymentMethodId: '507f1f77bcf86cd799439012',
        }),
        'idempotency-key': 'recurring-similar-key',
      },
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/recurring',
      {
        name: 'Rent',
        paymentType: 'expense',
        amount: 2400,
        frequency: 'monthly',
        startDate: '2026-05-10',
        categoryId: '507f1f77bcf86cd799439011',
        paymentMethodId: '507f1f77bcf86cd799439012',
        ignoreDuplicates: true,
      },
      {
        'Idempotency-Key': 'recurring-similar-key',
      }
    );
  });
});

describe('expenses update command', () => {
  it('puts payload to /api/expenses/:id with an idempotency key', async () => {
    const client = createMockClient();

    client.put.mockResolvedValueOnce({ id: 'expense-1', amount: 75 });

    const { result } = await runCliCommand({
      client,
      args: ['expenses', 'update', 'expense-1'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ amount: 75 }),
        'idempotency-key': 'update-key-1',
      },
    });

    expect(client.put).toHaveBeenCalledWith(
      '/api/expenses/expense-1',
      { amount: 75 },
      { 'Idempotency-Key': 'update-key-1' }
    );
    expect(result).toEqual({
      idempotencyKey: 'update-key-1',
      dryRun: false,
      id: 'expense-1',
      result: { id: 'expense-1', amount: 75 },
    });
  });

  it('encodes ids that contain URL-unsafe characters', async () => {
    // Mongo ObjectIds are URL-safe but agents may pass synthetic test ids
    // or other identifiers. encodeURIComponent prevents id-injection via
    // the path segment (a "/" in an id would otherwise route to a
    // different endpoint and probably 404 confusingly).
    const client = createMockClient();

    client.put.mockResolvedValueOnce({});

    await runCliCommand({
      client,
      args: ['expenses', 'update', 'has/slash'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ amount: 1 }),
        'idempotency-key': 'k',
      },
    });

    expect(client.put).toHaveBeenCalledWith(
      '/api/expenses/has%2Fslash',
      expect.anything(),
      expect.anything()
    );
  });

  it('requires --yes for update writes', async () => {
    const client = createMockClient();

    await expect(
      runCliCommand({
        client,
        args: ['expenses', 'update', 'expense-1'],
        flags: { 'payload-json': JSON.stringify({ amount: 1 }) },
      })
    ).rejects.toThrow(/--yes/);

    expect(client.put).not.toHaveBeenCalled();
  });

  it('returns dry-run metadata without putting', async () => {
    const client = createMockClient();

    const { result } = await runCliCommand({
      client,
      args: ['expenses', 'update', 'expense-1'],
      flags: {
        yes: true,
        'dry-run': true,
        'payload-json': JSON.stringify({ amount: 75 }),
      },
    });

    expect(client.put).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      id: 'expense-1',
      payload: { amount: 75 },
    });
  });
});

describe('income transactions update command', () => {
  it('puts payload to /api/income-transactions/:id with an idempotency key', async () => {
    const client = createMockClient();

    client.put.mockResolvedValueOnce({ id: 'income-1', amount: 300 });

    const { result } = await runCliCommand({
      client,
      args: ['income', 'transactions', 'update', 'income-1'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ amount: 300 }),
        'idempotency-key': 'income-update-key',
      },
    });

    expect(client.put).toHaveBeenCalledWith(
      '/api/income-transactions/income-1',
      { amount: 300 },
      { 'Idempotency-Key': 'income-update-key' }
    );
    expect(result).toMatchObject({
      idempotencyKey: 'income-update-key',
      dryRun: false,
      id: 'income-1',
      result: { id: 'income-1', amount: 300 },
    });
  });
});

describe('income transactions delete command', () => {
  it('deletes /api/income-transactions/:id with an idempotency key', async () => {
    const client = createMockClient();

    client.delete.mockResolvedValueOnce({ id: 'income-1' });

    const { result } = await runCliCommand({
      client,
      args: ['income', 'transactions', 'delete', 'income-1'],
      flags: {
        yes: true,
        'idempotency-key': 'income-del-key',
      },
    });

    expect(client.delete).toHaveBeenCalledWith(
      '/api/income-transactions/income-1',
      { 'Idempotency-Key': 'income-del-key' }
    );
    expect(result).toMatchObject({
      idempotencyKey: 'income-del-key',
      dryRun: false,
      id: 'income-1',
    });
  });
});

describe('expenses delete command', () => {
  it('deletes /api/expenses/:id with an idempotency key', async () => {
    const client = createMockClient();

    client.delete.mockResolvedValueOnce({ id: 'expense-1' });

    const { result } = await runCliCommand({
      client,
      args: ['expenses', 'delete', 'expense-1'],
      flags: {
        yes: true,
        'idempotency-key': 'del-key-1',
      },
    });

    expect(client.delete).toHaveBeenCalledWith('/api/expenses/expense-1', {
      'Idempotency-Key': 'del-key-1',
    });
    expect(result).toMatchObject({
      idempotencyKey: 'del-key-1',
      dryRun: false,
      id: 'expense-1',
    });
  });

  it('requires --yes for delete', async () => {
    const client = createMockClient();

    await expect(
      runCliCommand({
        client,
        args: ['expenses', 'delete', 'expense-1'],
        flags: {},
      })
    ).rejects.toThrow(/--yes/);

    expect(client.delete).not.toHaveBeenCalled();
  });

  it('rejects when id is missing', async () => {
    const client = createMockClient();

    await expect(
      runCliCommand({
        client,
        args: ['expenses', 'delete'],
        flags: { yes: true },
      })
    ).rejects.toThrow(/id is required/);

    expect(client.delete).not.toHaveBeenCalled();
  });

  it('returns dry-run metadata without deleting', async () => {
    const client = createMockClient();

    const { result } = await runCliCommand({
      client,
      args: ['expenses', 'delete', 'expense-1'],
      flags: {
        yes: true,
        'dry-run': true,
        'idempotency-key': 'k',
      },
    });

    expect(client.delete).not.toHaveBeenCalled();
    expect(result).toEqual({
      idempotencyKey: 'k',
      dryRun: true,
      id: 'expense-1',
    });
  });
});

describe('recurring update + delete commands', () => {
  // 7.13: server now honours Idempotency-Key for both routes
  // (recurring_template_update + recurring_template_delete event types
  // in the V7 idempotency module). 7.12 patched the CLI to omit the
  // header as a false-promise mitigation; 7.13 reverses that since the
  // promise is now real.

  it('updates a recurring payment via PUT with Idempotency-Key', async () => {
    const client = createMockClient();

    client.put.mockResolvedValueOnce({ id: 'rec-1', amount: 100 });

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'update', 'rec-1'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ amount: 100 }),
        'idempotency-key': 'rec-update-key',
      },
    });

    expect(client.put).toHaveBeenCalledWith(
      '/api/recurring/rec-1',
      { amount: 100 },
      { 'Idempotency-Key': 'rec-update-key' }
    );
    expect(result).toMatchObject({
      idempotencyKey: 'rec-update-key',
      id: 'rec-1',
    });
  });

  it('deletes a recurring payment with Idempotency-Key (retry-safe)', async () => {
    // The 7.13 server change: a retry after an ambiguous timeout returns
    // 200 (cache hit, no-op) instead of 404 — provided the same
    // (userId, contractName, key) triple is sent. Security comes from
    // the user filter on the cache lookup, not from sending the key.
    const client = createMockClient();

    client.delete.mockResolvedValueOnce({ id: 'rec-1' });

    await runCliCommand({
      client,
      args: ['recurring', 'delete', 'rec-1'],
      flags: { yes: true, 'idempotency-key': 'rec-del-key' },
    });

    expect(client.delete).toHaveBeenCalledWith('/api/recurring/rec-1', {
      'Idempotency-Key': 'rec-del-key',
    });
  });
});

describe('recurring instance commands (complete/skip/toggle)', () => {
  it('posts to /complete with the API field name paidAt + idempotency key', async () => {
    // The API schema is `paidAt` (recurringPaymentCompleteSchema), not
    // `date`. Zod strips unknown fields, so a CLI doc that suggested
    // `{date: ...}` would silently drop the agent's intended date and
    // the server would use the default current date — a P1 caught in
    // PR review. CLI usage now points to the API field names directly.
    const client = createMockClient();

    client.post.mockResolvedValueOnce({ ok: true });

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'complete', 'rec-1'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ paidAt: '2026-05-25' }),
        'idempotency-key': 'rec-complete-key',
      },
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/recurring/rec-1/complete',
      { paidAt: '2026-05-25' },
      { 'Idempotency-Key': 'rec-complete-key' }
    );
    expect(result).toMatchObject({
      action: 'complete',
      id: 'rec-1',
      result: { ok: true },
    });
  });

  it('posts to /skip with skippedDate + Idempotency-Key (7.13 server now honours it)', async () => {
    // 7.13 wired skipRecurringPayment through the V7 idempotency module
    // (recurring_skip event type). A retry with the same
    // Idempotency-Key returns the cached payment state without
    // re-advancing nextDueDate or adding another history entry.
    // 7.12 had this asserting no header (false-promise mitigation);
    // 7.13 reverses since the promise is now real.
    const client = createMockClient();

    client.post.mockResolvedValueOnce({ ok: true });

    await runCliCommand({
      client,
      args: ['recurring', 'skip', 'rec-1'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ skippedDate: '2026-05-25' }),
        'idempotency-key': 'rec-skip-key',
      },
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/recurring/rec-1/skip',
      { skippedDate: '2026-05-25' },
      { 'Idempotency-Key': 'rec-skip-key' }
    );
  });

  it('patches /toggle with empty body and no Idempotency-Key', async () => {
    // Toggle is intentionally non-idempotent — it flips isActive.
    // The server ignores any payload and any Idempotency-Key (the
    // handler doesn't even read validatedData). The CLI must reflect
    // both: send {} body, no Idempotency-Key header. Explicit
    // pause/resume semantics are tracked as a 7.13 follow-up.
    const client = createMockClient();

    client.patch.mockResolvedValueOnce({ id: 'rec-1', isActive: false });

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'toggle', 'rec-1'],
      flags: { yes: true },
    });

    expect(client.patch).toHaveBeenCalledWith(
      '/api/recurring/rec-1/toggle',
      {},
      expect.not.objectContaining({ 'Idempotency-Key': expect.anything() })
    );
    expect(result).toMatchObject({
      action: 'toggle',
      id: 'rec-1',
      result: { id: 'rec-1', isActive: false },
    });
  });

  it('requires --yes for instance ops', async () => {
    const client = createMockClient();

    await expect(
      runCliCommand({
        client,
        args: ['recurring', 'toggle', 'rec-1'],
        flags: {},
      })
    ).rejects.toThrow(/--yes/);
  });
});

describe('transfers commands (full CRUD — closes #2149)', () => {
  // Transfers had ZERO CLI surface before 7.12. This block verifies the
  // four new commands wire the right HTTP method/path and carry the
  // expected Idempotency-Key headers for agent-replay safety.

  it('list: GET /api/transfers with pagination flags forwarded as query params', async () => {
    const client = createMockClient();

    client.get.mockResolvedValueOnce({ transfers: [] });

    await runCliCommand({
      client,
      args: ['transfers', 'list'],
      flags: { limit: '5', page: '2' },
    });

    expect(client.get).toHaveBeenCalledWith('/api/transfers', {
      limit: '5',
      page: '2',
      fields: undefined,
    });
  });

  it('create: POST /api/transfers with payload + idempotency key', async () => {
    const client = createMockClient();

    client.post.mockResolvedValueOnce({ id: 'tx-1' });

    const payload = {
      fromAccountId: '507f1f77bcf86cd799439011',
      toAccountId: '507f1f77bcf86cd799439012',
      amount: 100,
      date: '2026-05-25',
    };
    const { result } = await runCliCommand({
      client,
      args: ['transfers', 'create'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify(payload),
        'idempotency-key': 'tx-create-key',
      },
    });

    expect(client.post).toHaveBeenCalledWith('/api/transfers', payload, {
      'Idempotency-Key': 'tx-create-key',
    });
    expect(result).toEqual({
      idempotencyKey: 'tx-create-key',
      dryRun: false,
      result: { id: 'tx-1' },
    });
  });

  it('update: PUT /api/transfers/:id with payload + idempotency key', async () => {
    const client = createMockClient();

    client.put.mockResolvedValueOnce({ id: 'tx-1', amount: 200 });

    const { result } = await runCliCommand({
      client,
      args: ['transfers', 'update', 'tx-1'],
      flags: {
        yes: true,
        'payload-json': JSON.stringify({ amount: 200 }),
        'idempotency-key': 'tx-update-key',
      },
    });

    expect(client.put).toHaveBeenCalledWith(
      '/api/transfers/tx-1',
      { amount: 200 },
      { 'Idempotency-Key': 'tx-update-key' }
    );
    expect(result).toMatchObject({ id: 'tx-1' });
  });

  it('delete: DELETE /api/transfers/:id with idempotency key', async () => {
    const client = createMockClient();

    client.delete.mockResolvedValueOnce({ id: 'tx-1' });

    await runCliCommand({
      client,
      args: ['transfers', 'delete', 'tx-1'],
      flags: { yes: true, 'idempotency-key': 'tx-del-key' },
    });

    expect(client.delete).toHaveBeenCalledWith('/api/transfers/tx-1', {
      'Idempotency-Key': 'tx-del-key',
    });
  });
});

describe('list-command filter parity (7.12)', () => {
  // The API has supported search / minAmount / maxAmount on expense and
  // income list endpoints for a while; the CLI just never exposed flags
  // for them. These tests verify the new flags forward through with the
  // camelCase mapping the API expects.

  it('expenses list forwards --search / --min-amount / --max-amount with camelCase mapping', async () => {
    const client = createMockClient();

    client.get.mockResolvedValueOnce({ expenses: [] });

    await runCliCommand({
      client,
      args: ['expenses', 'list'],
      flags: {
        search: 'groceries',
        'min-amount': '50',
        'max-amount': '500',
      },
    });

    expect(client.get).toHaveBeenCalledWith(
      '/api/expenses',
      expect.objectContaining({
        search: 'groceries',
        minAmount: '50',
        maxAmount: '500',
      })
    );
  });

  it('income transactions list forwards filter flags with camelCase mapping', async () => {
    const client = createMockClient();

    client.get.mockResolvedValueOnce({ incomeTransactions: [] });

    await runCliCommand({
      client,
      args: ['income', 'transactions', 'list'],
      flags: { search: 'bonus', 'min-amount': '100' },
    });

    expect(client.get).toHaveBeenCalledWith(
      '/api/income-transactions',
      expect.objectContaining({
        search: 'bonus',
        minAmount: '100',
      })
    );
  });

  it('flag-to-query name mapping leaves un-mapped flags untouched', async () => {
    // Sanity: existing flags like `category` and `payment-method` keep
    // their current behaviour (passed through verbatim). queryFlagMap is
    // additive — opt-in per command, no global rewrite.
    const client = createMockClient();

    client.get.mockResolvedValueOnce({ expenses: [] });

    await runCliCommand({
      client,
      args: ['expenses', 'list'],
      flags: {
        category: 'cat-1',
        'payment-method': 'pm-1',
      },
    });

    expect(client.get).toHaveBeenCalledWith(
      '/api/expenses',
      expect.objectContaining({
        category: 'cat-1',
        'payment-method': 'pm-1',
      })
    );
  });
});

describe('recurring pause + resume commands (7.13)', () => {
  // 7.13: pause and resume hit the new PATCH /api/recurring/:id/status
  // endpoint with body {isActive: false} or {isActive: true}. Naturally
  // idempotent — setting to X twice yields the same final state — so
  // they deliberately don't send Idempotency-Key. Replaces toggle's
  // flip semantics for agents that want predictable state-setting.

  it('pause: PATCHes /status with {isActive: false}', async () => {
    const client = createMockClient();

    client.patch.mockResolvedValueOnce({ id: 'rec-1', isActive: false });

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'pause', 'rec-1'],
      flags: { yes: true },
    });

    expect(client.patch).toHaveBeenCalledWith('/api/recurring/rec-1/status', {
      isActive: false,
    });
    expect(result).toMatchObject({
      action: 'pause',
      id: 'rec-1',
      result: { id: 'rec-1', isActive: false },
    });
  });

  it('resume: PATCHes /status with {isActive: true}', async () => {
    const client = createMockClient();

    client.patch.mockResolvedValueOnce({ id: 'rec-1', isActive: true });

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'resume', 'rec-1'],
      flags: { yes: true },
    });

    expect(client.patch).toHaveBeenCalledWith('/api/recurring/rec-1/status', {
      isActive: true,
    });
    expect(result).toMatchObject({
      action: 'resume',
      id: 'rec-1',
      result: { id: 'rec-1', isActive: true },
    });
  });

  it('pause requires --yes', async () => {
    const client = createMockClient();

    await expect(
      runCliCommand({
        client,
        args: ['recurring', 'pause', 'rec-1'],
        flags: {},
      })
    ).rejects.toThrow(/--yes/);

    expect(client.patch).not.toHaveBeenCalled();
  });

  it('pause supports --dry-run without calling the API', async () => {
    const client = createMockClient();

    const { result } = await runCliCommand({
      client,
      args: ['recurring', 'pause', 'rec-1'],
      flags: { yes: true, 'dry-run': true },
    });

    expect(client.patch).not.toHaveBeenCalled();
    expect(result).toEqual({
      dryRun: true,
      id: 'rec-1',
      action: 'pause',
      payload: { isActive: false },
    });
  });
});

describe('CLI error handling', () => {
  it('maps duplicate-blocked API errors to exit code 1 and preserves details', () => {
    const duplicateError = new FiscavaApiError({
      code: 'DUPLICATE_BLOCKED',
      message: 'Potential duplicate expense detected.',
      status: 409,
      details: {
        isDuplicate: true,
        duplicate: { id: 'expense-existing' },
      },
    });

    expect(resolveCliFailure(duplicateError)).toEqual({
      exitCode: 1,
      payload: {
        code: 'DUPLICATE_BLOCKED',
        message: 'Potential duplicate expense detected.',
        status: 409,
        details: {
          isDuplicate: true,
          duplicate: { id: 'expense-existing' },
        },
      },
    });
  });
});

describe('resolveConfig — locked prod API URL (#2182)', () => {
  it('always uses the hardcoded production origin, ignoring --api-url and FISCAVA_API_URL', () => {
    const previous = process.env.FISCAVA_API_URL;
    process.env.FISCAVA_API_URL = 'https://evil.example.com';

    try {
      const config = resolveConfig({
        'api-url': 'https://attacker.example.com',
        // point at a non-existent token file so we never read a real dev token
        'token-file': join(tmpdir(), 'fiscava-nonexistent-token-for-test'),
      });

      expect(config.apiUrl).toBe(PRODUCTION_API_URL);
      expect(PRODUCTION_API_URL).toBe('https://api.fiscava.app');
    } finally {
      if (previous === undefined) {
        delete process.env.FISCAVA_API_URL;
      } else {
        process.env.FISCAVA_API_URL = previous;
      }
    }
  });
});

describe('requireSessionToken (#2182)', () => {
  beforeEach(() => {
    delete process.env.FISCAVA_SESSION_TOKEN;
  });

  function context(opts: {
    flags?: Record<string, string | boolean>;
    token?: string;
  }) {
    return {
      client: createMockClient() as unknown as FiscavaApiClient,
      config: { ...createConfig(opts.token), token: opts.token },
      args: [],
      flags: opts.flags ?? {},
    } as Parameters<typeof requireSessionToken>[0];
  }

  it('prefers an explicit --session-token', () => {
    expect(
      requireSessionToken(
        context({ flags: { 'session-token': 'jwt-flag' }, token: 'stored' })
      )
    ).toBe('jwt-flag');
  });

  it('falls back to the stored login token (no browser JWT needed)', () => {
    expect(requireSessionToken(context({ token: 'stored-login-token' }))).toBe(
      'stored-login-token'
    );
  });

  it('throws a clear error when not authenticated', () => {
    expect(() => requireSessionToken(context({ token: undefined }))).toThrow(
      /Run `fiscava auth login` first/
    );
  });
});
