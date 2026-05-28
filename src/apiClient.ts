export type FiscavaApiClientOptions = {
  apiUrl: string;
  token?: string;
};

export type ApiErrorPayload = {
  code: string;
  message: string;
  status?: number;
  correlationId?: string;
  details?: unknown;
};

export class FiscavaApiError extends Error {
  public readonly payload: ApiErrorPayload;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.payload = payload;
  }
}

export class FiscavaApiClient {
  private readonly apiUrl: string;
  private readonly token?: string;

  constructor(options: FiscavaApiClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.token = options.token;
  }

  async get<T>(
    path: string,
    query: Record<string, string | undefined> = {}
  ): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    return this.request<T>('POST', path, body, {}, extraHeaders);
  }

  async put<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    return this.request<T>('PUT', path, body, {}, extraHeaders);
  }

  async patch<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    return this.request<T>('PATCH', path, body, {}, extraHeaders);
  }

  async delete<T>(
    path: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    return this.request<T>('DELETE', path, undefined, {}, extraHeaders);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string | undefined> = {},
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);

    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    });

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    Object.assign(headers, extraHeaders);

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const correlationId = response.headers.get('x-correlation-id') ?? undefined;
    const text = await response.text();
    const parsed = text
      ? (JSON.parse(text) as {
          success?: boolean;
          data?: unknown;
          error?: unknown;
        })
      : {};

    if (!response.ok || parsed.success === false) {
      const data = parsed.data as { error?: string } | undefined;
      throw new FiscavaApiError({
        code: response.status === 401 ? 'AUTH_REQUIRED' : 'API_ERROR',
        message: data?.error ?? response.statusText,
        status: response.status,
        correlationId,
      });
    }

    return parsed.data as T;
  }
}
