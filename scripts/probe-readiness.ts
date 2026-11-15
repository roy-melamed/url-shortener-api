/** Opt-in evidence collector; no scheduler, alert forcing or deployment. */
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
export async function probeReadiness(target: string, fetcher: typeof fetch = fetch) {
  const started = performance.now();
  let healthy = false;
  try {
    const response = await fetcher(target, {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    // Drain the bounded health payload without retaining it in evidence.
    await response.body?.cancel();
    healthy = response.status === 200;
  } catch {
    /* report failed observation, never driver/URL/credential text */
  }
  return {
    timestamp: new Date().toISOString(),
    healthy,
    durationMs: Math.round(performance.now() - started),
  };
}
export async function runReadinessProbe(args: string[]): Promise<number> {
  const [target, samples = '1', intervalMs = '60000', authorization] = args;
  let url: URL;
  try {
    url = new URL(target!);
  } catch {
    return 2;
  }
  const count = Number(samples),
    interval = Number(intervalMs);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/readyz' ||
    (!local && (authorization !== '--authorized-nonproduction' || url.protocol !== 'https:')) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 600 ||
    !Number.isSafeInteger(interval) ||
    interval < 1000
  )
    return 2;
  let failed = false;
  for (let sample = 0; sample < count; sample++) {
    const observation = await probeReadiness(url.href);
    console.log(JSON.stringify(observation));
    failed ||= !observation.healthy;
    if (sample + 1 < count) await delay(interval);
  }
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exit = await runReadinessProbe(process.argv.slice(2));
  if (exit === 2)
    console.error(
      'Usage: probe-readiness <local /readyz URL> [samples 1..600] [intervalMs >=1000]; remote HTTPS requires explicit --authorized-nonproduction',
    );
  process.exitCode = exit;
}
