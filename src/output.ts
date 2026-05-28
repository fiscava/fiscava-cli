import { ApiErrorPayload } from './apiClient';

export function selectFields(value: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => selectFields(item, fields));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    fields
      .map(field => [field, (value as Record<string, unknown>)[field]])
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
  );
}

export function printData(
  value: unknown,
  format: 'json' | 'table' | 'ndjson'
): void {
  if (format === 'ndjson') {
    const rows = Array.isArray(value) ? value : [value];
    rows.forEach(row => process.stdout.write(`${JSON.stringify(row)}\n`));
    return;
  }

  if (format === 'table') {
    console.table(value);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printError(error: ApiErrorPayload): void {
  process.stderr.write(
    `${JSON.stringify({ success: false, error }, null, 2)}\n`
  );
}
