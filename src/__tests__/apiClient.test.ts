import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiscavaApiClient, FiscavaApiError } from '../apiClient';

// FiscavaApiClient is a thin wrapper around fetch — the tests below verify
// the wire-format invariants AI agents rely on: HTTP method routing,
// Content-Type only set when there's a body, Authorization header threading,
// idempotency-key forwarding via extraHeaders, error coalescing into
// FiscavaApiError.
//
// Mock fetch directly rather than going through MSW — the surface is small
// and the contract is "method + URL + headers + body in; parsed data out".

type FetchCall = {
  url: string;
  init: RequestInit;
};

function mockFetchOk(payload: unknown, calls: FetchCall[]) {
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });

    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

describe('FiscavaApiClient HTTP methods', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('put() sends a PUT with JSON body and forwards extraHeaders', async () => {
    const calls: FetchCall[] = [];
    mockFetchOk({ id: 'expense-1', amount: 50 }, calls);

    const client = new FiscavaApiClient({
      apiUrl: 'http://localhost:4000',
      token: 'fcv_pat_token',
    });

    const result = await client.put<{ id: string; amount: number }>(
      '/api/expenses/expense-1',
      { amount: 50 },
      { 'Idempotency-Key': 'agent-key-1' }
    );

    expect(result).toEqual({ id: 'expense-1', amount: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.body).toBe(JSON.stringify({ amount: 50 }));

    const headers = calls[0].init.headers as Record<string, string>;

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer fcv_pat_token');
    expect(headers['Idempotency-Key']).toBe('agent-key-1');
  });

  it('patch() sends a PATCH with JSON body and forwards extraHeaders', async () => {
    const calls: FetchCall[] = [];
    mockFetchOk({ id: 'recurring-1', isActive: false }, calls);

    const client = new FiscavaApiClient({
      apiUrl: 'http://localhost:4000',
      token: 'fcv_pat_token',
    });

    const result = await client.patch<{ id: string; isActive: boolean }>(
      '/api/recurring/recurring-1/toggle',
      {},
      { 'Idempotency-Key': 'agent-key-2' }
    );

    expect(result).toEqual({ id: 'recurring-1', isActive: false });
    expect(calls[0].init.method).toBe('PATCH');

    const headers = calls[0].init.headers as Record<string, string>;

    expect(headers['Idempotency-Key']).toBe('agent-key-2');
  });

  it('delete() now accepts extraHeaders so destructive ops can carry an idempotency key', async () => {
    // Pre-7.12 delete() had no extraHeaders param — an agent retrying a
    // delete after a transient network error couldn't dedupe server-side.
    // 7.12 adds the param so DELETE matches PUT/POST/PATCH on this axis.
    const calls: FetchCall[] = [];
    mockFetchOk({ id: 'expense-1' }, calls);

    const client = new FiscavaApiClient({
      apiUrl: 'http://localhost:4000',
      token: 'fcv_pat_token',
    });

    await client.delete<{ id: string }>('/api/expenses/expense-1', {
      'Idempotency-Key': 'delete-key-1',
    });

    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();

    const headers = calls[0].init.headers as Record<string, string>;

    expect(headers['Idempotency-Key']).toBe('delete-key-1');
    // Content-Type must NOT be set on a DELETE without a body — some
    // servers reject DELETE+Content-Type as malformed.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws FiscavaApiError with structured payload on non-2xx', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            data: { error: 'Expense not found' },
          }),
          {
            status: 404,
            headers: {
              'content-type': 'application/json',
              'x-correlation-id': 'corr-123',
            },
          }
        )
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = new FiscavaApiClient({
      apiUrl: 'http://localhost:4000',
      token: 'fcv_pat_token',
    });

    await expect(
      client.put('/api/expenses/missing', { amount: 10 })
    ).rejects.toThrow(FiscavaApiError);

    try {
      await client.put('/api/expenses/missing', { amount: 10 });
    } catch (err) {
      const e = err as FiscavaApiError;

      expect(e.payload.status).toBe(404);
      expect(e.payload.message).toBe('Expense not found');
      expect(e.payload.correlationId).toBe('corr-123');
    }
  });
});
