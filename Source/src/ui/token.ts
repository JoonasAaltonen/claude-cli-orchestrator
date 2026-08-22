/**
 * The dashboard's shared secret.
 *
 * N4 is blunt about it: a loopback bind authenticates nobody. Any process on this
 * machine can reach 127.0.0.1, and this particular server can spend the operator's
 * quota and invoke agents — so "only local" is not a permission model.
 *
 * The token is **persisted, not minted per launch**. A fresh secret every start
 * would mean no bookmark, no desktop shortcut, and a URL copied out of terminal
 * output every single time; friction that high is not paid, it is worked around.
 * One stable URL, rotated on request.
 *
 * Where it lives matters as much as that it exists. It sits beside the
 * configuration file, at the checkout root — deliberately **not** in the comms
 * root, which every dispatched agent can read in order to reach `status.md`. A
 * secret readable by the things it authorises is not a secret.
 */
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config/load.js';
import { readTextIfExists, writeText } from '../util/fsx.js';

export const TOKEN_FILENAME = '.orchestrator-ui-token';

/** Beside the configuration file — outside every agent's workspace. */
export function tokenPath(config: Config): string {
  return path.join(path.dirname(config.configFile), TOKEN_FILENAME);
}

function mint(): string {
  return randomBytes(24).toString('base64url');
}

export interface TokenResult {
  token: string;
  /** True when this call created it, so the CLI can say where it went. */
  created: boolean;
  file: string;
}

/**
 * Reads the stored token, creating one on first use.
 *
 * `rotate` discards the old value, which invalidates every existing bookmark —
 * that is the point of it, so it is never implicit.
 */
export async function ensureToken(config: Config, rotate = false): Promise<TokenResult> {
  const file = tokenPath(config);
  if (!rotate) {
    const existing = (await readTextIfExists(file))?.trim();
    if (existing) return { token: existing, created: false, file };
  }
  const token = mint();
  await writeText(file, token + '\n');
  return { token, created: true, file };
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length, so the lengths are equalised first and the result folded in.
 */
export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  const width = Math.max(a.length, b.length);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}
