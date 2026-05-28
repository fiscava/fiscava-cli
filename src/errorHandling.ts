import { ApiErrorPayload, FiscavaApiError } from './apiClient';

export function resolveCliFailure(error: unknown): {
  exitCode: number;
  payload: ApiErrorPayload;
} {
  if (error instanceof FiscavaApiError) {
    return {
      payload: error.payload,
      exitCode: error.payload.status === 401 ? 3 : 1,
    };
  }

  const message = error instanceof Error ? error.message : 'Unknown error';

  return {
    payload: {
      code: 'USAGE_OR_CONFIG_ERROR',
      message,
    },
    exitCode: 2,
  };
}
