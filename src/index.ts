#!/usr/bin/env node
import { parseArgs } from 'util';
import { FiscavaApiClient } from './apiClient';
import { resolveConfig } from './config';
import { runCommand, usage } from './commands';
import { resolveCliFailure } from './errorHandling';
import { printData, printError, selectFields } from './output';

const optionNames = [
  'api-url',
  'token',
  'token-file',
  'format',
  'fields',
  'from',
  'to',
  'category',
  'payment-method',
  'limit',
  'page',
  'status',
  'search',
  'min-amount',
  'max-amount',
  'name',
  'scopes',
  'expires',
  'session-token',
  'email',
  'code',
  'two-factor-code',
  'no-remember',
  'payload',
  'payload-json',
  'idempotency-key',
  'allow-duplicate',
  'allow-similar',
  'dry-run',
  'yes',
  'help',
] as const;

const booleanOptions = new Set([
  'help',
  'no-remember',
  'allow-duplicate',
  'allow-similar',
  'dry-run',
  'yes',
]);

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: Object.fromEntries(
      optionNames.map(name => [
        name,
        {
          type: booleanOptions.has(name) ? 'boolean' : 'string',
        },
      ])
    ),
  });

  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(usage());
    return;
  }

  const flags = parsed.values as Record<string, string | boolean>;
  const config = resolveConfig(flags);
  const client = new FiscavaApiClient({
    apiUrl: config.apiUrl,
    token: config.token,
  });
  const result = await runCommand({
    client,
    config,
    args: parsed.positionals,
    flags,
  });

  printData(selectFields(result, config.fields), config.format);
}

main().catch(error => {
  const { payload, exitCode } = resolveCliFailure(error);
  printError(payload);
  process.exitCode = exitCode;
});
