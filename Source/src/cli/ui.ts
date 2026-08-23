/**
 * `orchestrator ui` — serve the operator dashboard.
 *
 * The URL is stable across restarts because the token is stored rather than minted
 * per launch, which is what makes a bookmark or a desktop shortcut work. `--open`
 * exists so the shortcut never has to carry the URL at all.
 */
import process from 'node:process';
import { spawn } from 'node:child_process';
import type { Config } from '../config/load.js';
import { ensureToken, tokenPath } from '../ui/token.js';
import { startUiServer } from '../ui/server.js';
import { startProblemLog } from '../log/problems.js';
import { bold, dim, green, heading, red, yellow } from './render.js';

export interface UiOptions {
  port?: number;
  open?: boolean;
  newToken?: boolean;
  /** Where failures are appended. Defaults to state/problems.jsonl under the comms root. */
  logFile?: string | null;
}

/** Best-effort browser launch. A failure here is a note, never a fatal. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed regardless */
  }
}

export async function runUi(config: Config, opts: UiOptions): Promise<number> {
  const { token, created, file } = await ensureToken(config, !!opts.newToken);
  const port = opts.port ?? config.ports.operatorView;

  // Before the server exists, so a failure to bind is itself recorded.
  const problemLog = startProblemLog(config, opts.logFile ?? null);

  let server;
  try {
    server = await startUiServer(config, token, port);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(`Could not bind ${config.ports.bindAddress}:${port} — ${msg}`));
    if (/EADDRINUSE/.test(msg)) {
      console.error(dim('  Another dashboard is probably already running. Close it, or pass --port.'));
    }
    return 2;
  }

  console.log(heading('Operator dashboard'));
  console.log(`  ${bold(server.url)}`);
  console.log(dim(`  bound to ${config.ports.bindAddress}:${server.port} — loopback only, not reachable from the network`));
  console.log(dim(`  errors print here and append to ${problemLog}`));

  if (created) {
    console.log(`\n  ${green(opts.newToken ? 'rotated' : 'created')} ${file}`);
    console.log(dim('  The URL above is stable — bookmark it. Rotate with `orchestrator ui --new-token`.'));
    if (opts.newToken) console.log(yellow('  Any existing bookmark of the old URL no longer works.'));
  }

  if (opts.open) openBrowser(server.url);
  else console.log(dim('\n  --open launches your browser at it, so a shortcut needs no URL.'));

  console.log(dim('\n  Ctrl+C to stop.'));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  console.log(dim('\nDashboard stopped. The token is unchanged, so the same URL works next time.'));
  return 0;
}

export { tokenPath };
