/**
 * Launcher for the rent-roll parser that makes it work behind a corporate
 * TLS-intercepting proxy (e.g. the Newmark sandbox), then runs the pipeline.
 *
 * Why this exists: when HTTPS is intercepted by a corporate proxy, Node does
 * not trust the proxy's CA, so calls to api.anthropic.com fail with a
 * certificate error. The fix is to point NODE_EXTRA_CA_CERTS at the proxy's CA
 * bundle — but that variable is only read at process *startup*, so we detect
 * the CA here and spawn the real entry (parse-rent-roll.ts) as a child with the
 * variable set. On machines with no such proxy this is a no-op passthrough.
 *
 * Usage (same args as parse-rent-roll.ts):
 *   npx tsx scripts/run.ts <file.xlsx|file.pdf> [--out <path>] [--json]
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Ordered CA candidates: an explicit override wins, then the known corporate
// proxy CA path, then the aggregated system bundle (harmless to add).
const CA_CANDIDATES = [
  process.env.NODE_EXTRA_CA_CERTS,
  '/usr/local/share/ca-certificates/mitm-proxy-ca.crt',
  '/etc/ssl/certs/ca-certificates.crt',
].filter((p): p is string => !!p);

const ca = CA_CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

const env = { ...process.env };
if (ca) {
  env.NODE_EXTRA_CA_CERTS = ca;
  if (process.env.NODE_EXTRA_CA_CERTS !== ca) {
    console.error(`Trusting proxy/system CA bundle: ${ca}`);
  }
}

const entry = path.join(__dirname, 'parse-rent-roll.ts');
const res = spawnSync('npx', ['--yes', 'tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
process.exit(res.status ?? 1);
