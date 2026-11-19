// Entrypoint. In a trial the env hands us MAKEFUN_ENV_URL: we bind an ephemeral port,
// register it, then long-poll /done until the suite says the trial is over and exit 0.
// Without MAKEFUN_ENV_URL (local runs) we serve on PORT (default 18080) until killed.
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const { server } = createApp();

async function registerAndWait(port: number): Promise<void> {
  const registerUrl = `${envUrl.replace(/\/+$/, '')}/register`;
  const doneUrl = `${envUrl.replace(/\/+$/, '')}/done`;
  const registerResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registerResponse.ok) {
    throw new Error(`register failed: HTTP ${registerResponse.status}`);
  }
  for (;;) {
    const response = await fetch(doneUrl);
    if (!response.ok) throw new Error(`done poll failed: HTTP ${response.status}`);
    const body = (await response.json()) as { done?: boolean };
    if (body.done === true) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function listen(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function main(): Promise<void> {
  if (envUrl === '') {
    const port = parseInt(process.env.PORT ?? '18080', 10);
    const bound = await listen(Number.isFinite(port) ? port : 18080, '127.0.0.1');
    console.log(`github-core-clone listening on http://127.0.0.1:${bound}`);
    return;
  }
  const port = await listen(0, '127.0.0.1');
  console.log(`github-core-clone listening on ephemeral port ${port}, registering with ${envUrl}`);
  await registerAndWait(port);
  server.close();
  console.log('done; exiting 0');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
