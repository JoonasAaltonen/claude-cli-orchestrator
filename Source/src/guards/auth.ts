/**
 * Authentication preflight.
 *
 * This exists because of how the failure looks without it. `claude` can be installed
 * and on PATH while not being logged in; nothing about the binary's presence says
 * otherwise. The first dispatch then fails — and per V1 it fails in the shape that is
 * hardest to read, with the process exiting cleanly and no artefact in the outbox,
 * which is indistinguishable from an agent that simply declined the work.
 *
 * The cost of that confusion is highest in the case this application is actually for:
 * starting a chain and walking away. An operator who returns an hour later to an
 * empty ledger should be told "you were logged out", not left to infer it.
 *
 * So this runs before the first invocation of any run, not after it fails.
 * `claude auth status` returns machine-readable JSON and touches no quota.
 */
import { spawn } from 'node:child_process';
import type { Config } from '../config/load.js';

export interface AuthStatus {
  /** Whether the check itself could be performed. Distinct from being logged in. */
  checked: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  organisation: string | null;
  subscriptionType: string | null;
  /** Set when the check could not run at all — binary missing, unexpected output. */
  error: string | null;
  /** What to tell the operator. Empty when everything is fine. */
  advice: string[];
}

/**
 * F1 — authentication mode is configuration, not architecture. An `api-key`
 * installation is not logged in through the CLI at all, so the check that applies is
 * whether the variable is set.
 */
export async function checkAuth(config: Config): Promise<AuthStatus> {
  const base: AuthStatus = {
    checked: false,
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
    email: null,
    organisation: null,
    subscriptionType: null,
    error: null,
    advice: [],
  };

  if (config.auth.mode === 'api-key') {
    const key = process.env[config.auth.apiKeyEnvVar];
    return {
      ...base,
      checked: true,
      loggedIn: !!key,
      authMethod: 'api-key',
      advice: key
        ? []
        : [
            `auth.mode is "api-key" but $${config.auth.apiKeyEnvVar} is not set in this shell.`,
            `Set it, or switch auth.mode back to "subscription" in ${config.configFile}.`,
          ],
    };
  }

  const out = await run(config.claudeBin, ['auth', 'status']);
  if (out.error) {
    return {
      ...base,
      error: out.error,
      advice: [
        `Could not run \`${config.claudeBin} auth status\`.`,
        out.error.includes('ENOENT')
          ? `The binary was not found. Install Claude Code, or set "claudeBin" in ${config.configFile} to its full path.`
          : out.error,
      ],
    };
  }

  let parsed: any;
  try {
    // Tolerate anything the CLI prints around the JSON object.
    const start = out.stdout.indexOf('{');
    const end = out.stdout.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object in the output');
    parsed = JSON.parse(out.stdout.slice(start, end + 1));
  } catch (err: any) {
    // A future CLI could change this output. Report it as unknown rather than as
    // logged out: refusing to dispatch on a parse failure would be worse than the
    // problem, and the invocation itself will still surface a real auth failure.
    return {
      ...base,
      error: `Could not read the auth status output: ${err?.message ?? String(err)}`,
      advice: [
        `\`${config.claudeBin} auth status\` returned something this version does not recognise.`,
        'Proceeding anyway — an authentication problem will still show up on the first invocation.',
      ],
    };
  }

  const loggedIn = parsed?.loggedIn === true;
  return {
    checked: true,
    loggedIn,
    authMethod: parsed?.authMethod ?? null,
    apiProvider: parsed?.apiProvider ?? null,
    email: parsed?.email ?? null,
    organisation: parsed?.orgName ?? null,
    subscriptionType: parsed?.subscriptionType ?? null,
    error: null,
    advice: loggedIn
      ? []
      : [
          `\`${config.claudeBin}\` is installed but not logged in, so every invocation would fail.`,
          `Run: ${config.claudeBin} auth login`,
          'Nothing has been dispatched and nothing has been spent.',
        ],
  };
}

/**
 * The gate used before dispatching. Returns null when it is safe to proceed.
 *
 * A check that could not run is *not* treated as a failure — see the parse branch
 * above. Only a definite "not logged in" stops the run.
 */
export function authBlocker(status: AuthStatus): string[] | null {
  if (status.checked && !status.loggedIn) return status.advice;
  return null;
}

/** One-line summary for `doctor` and the run header. */
export function describeAuth(status: AuthStatus): string {
  if (!status.checked) return status.error ?? 'authentication status unknown';
  if (!status.loggedIn) return 'not logged in';
  const bits = [status.authMethod, status.subscriptionType, status.email].filter(Boolean);
  return `logged in${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: { stdout: string; stderr: string; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (err) => done({ stdout, stderr, error: err.message }));
    child.on('close', (code) =>
      done(code === 0 ? { stdout, stderr } : { stdout, stderr, error: `exit ${code}: ${stderr.trim() || stdout.trim()}` })
    );
    // A preflight must never be the thing that hangs a run.
    setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ stdout, stderr, error: 'timed out after 15s' });
    }, 15_000).unref();
  });
}
