import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type CliConfig = {
  apiUrl: string;
  token?: string;
  tokenFile?: string;
  format: 'json' | 'table' | 'ndjson';
  fields?: string[];
};

export function defaultTokenFile(): string {
  return join(homedir(), '.config', 'fiscava', 'token');
}

export function readTokenFile(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  const mode = statSync(path).mode & 0o777;

  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Token file ${path} must not be readable by group or others`
    );
  }

  return readFileSync(path, 'utf8').trim() || undefined;
}

export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems on Windows do not support chmod semantics.
  }
}

export function resolveConfig(
  flags: Record<string, string | boolean>
): CliConfig {
  const tokenFile =
    typeof flags['token-file'] === 'string'
      ? flags['token-file']
      : (process.env['FISCAVA_TOKEN_FILE'] ?? defaultTokenFile());
  const tokenFromFile = readTokenFile(tokenFile);
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'json';

  if (!['json', 'table', 'ndjson'].includes(format)) {
    throw new Error('--format must be json, table, or ndjson');
  }

  return {
    apiUrl:
      typeof flags['api-url'] === 'string'
        ? flags['api-url']
        : (process.env['FISCAVA_API_URL'] ?? 'http://localhost:4000'),
    token:
      typeof flags['token'] === 'string'
        ? flags['token']
        : (process.env['FISCAVA_TOKEN'] ?? tokenFromFile),
    tokenFile,
    format: format as CliConfig['format'],
    fields:
      typeof flags['fields'] === 'string'
        ? flags['fields']
            .split(',')
            .map(field => field.trim())
            .filter(Boolean)
        : undefined,
  };
}
