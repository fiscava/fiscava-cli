import { createInterface } from 'readline/promises';

export async function promptText(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return (await rl.question(`${label}: `)).trim();
  } finally {
    rl.close();
  }
}

export async function promptSecret(label: string): Promise<string> {
  const mutableOutput = process.stderr as NodeJS.WritableStream & {
    muted?: boolean;
  };
  const originalWrite = mutableOutput.write.bind(mutableOutput);

  mutableOutput.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (mutableOutput.muted) {
      return true;
    }

    return originalWrite(chunk, ...(args as []));
  }) as NodeJS.WritableStream['write'];

  const rl = createInterface({ input: process.stdin, output: mutableOutput });

  try {
    originalWrite(`${label}: `);
    mutableOutput.muted = true;

    const answer = await rl.question('');

    mutableOutput.muted = false;
    process.stderr.write('\n');

    return answer;
  } finally {
    mutableOutput.muted = false;
    mutableOutput.write = originalWrite as NodeJS.WritableStream['write'];
    rl.close();
  }
}
