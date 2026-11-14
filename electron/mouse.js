import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const helperPath = fileURLToPath(new URL('../native/bin/flmouse', import.meta.url));
const buildPath = fileURLToPath(new URL('../native/build.sh', import.meta.url));
const TIMEOUT_MS = 2000;
const RESTART_MS = 1000;

export function startMouse(options = {}) {
  const dry = options.dry === true || process.env.FLMOUSE_DRY === '1';
  const log = typeof options.log === 'function' ? options.log : () => {};
  const report = (message) => {
    // Diagnostics must never disrupt transport or leave promises unsettled.
    try { log(message); } catch { /* Ignore exceptions from a caller's logger. */ }
  };
  let buildError;
  if (!existsSync(helperPath)) {
    const result = spawnSync('/bin/sh', [buildPath], { encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0 || !existsSync(helperPath)) {
      const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim()
        || `exit status ${result.status}`;
      buildError = new Error(`Failed to build native/bin/flmouse: ${detail}`);
      report(buildError.message);
    }
  }

  let child = null;
  let lastSpawn = -Infinity;
  let buffer = '';
  let blocked = false;
  let scheduled = null;
  let restartTimer = null;
  let waitingMove = null;
  const outgoing = [];
  const pending = [];

  function settle(entry, error, reply) {
    for (const waiter of entry.waiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve(reply);
    }
    entry.waiters.clear();
  }

  function reset(error) {
    const previous = child;
    child = null;
    buffer = '';
    blocked = false;
    waitingMove = null;
    if (scheduled !== null) clearImmediate(scheduled);
    if (restartTimer !== null) clearTimeout(restartTimer);
    scheduled = restartTimer = null;
    for (const entry of pending.splice(0)) settle(entry, error);
    for (const entry of outgoing.splice(0)) settle(entry, error);
    if (previous && previous.exitCode === null && previous.signalCode === null) previous.kill();
  }

  function launch() {
    lastSpawn = performance.now();
    const process = spawn(helperPath, dry ? ['--dry'] : [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = process;
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    const fail = (error) => {
      if (child !== process) return;
      report(error.message);
      reset(error);
    };
    process.on('error', (error) => fail(new Error(`flmouse failed to start: ${error.message}`)));
    process.on('exit', (code, signal) => fail(new Error(`flmouse exited (${signal || code})`)));
    process.stdin.on('error', (error) => fail(new Error(`flmouse stdin failed: ${error.message}`)));
    process.stdout.on('error', (error) => fail(new Error(`flmouse stdout failed: ${error.message}`)));
    process.stderr.on('error', (error) => report(`flmouse stderr failed: ${error.message}`));
    process.stderr.on('data', (chunk) => report(`flmouse: ${chunk.trimEnd()}`));
    process.stdin.on('drain', () => {
      if (child !== process) return;
      blocked = false;
      schedule();
    });
    process.stdout.on('data', (chunk) => {
      if (child !== process) return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const entry = pending.shift();
        if (!entry) {
          report('flmouse sent an unsolicited reply');
          continue;
        }
        try {
          settle(entry, null, JSON.parse(line));
        } catch (error) {
          settle(entry, new Error(`Invalid JSON reply from flmouse: ${error.message}`));
        }
      }
      schedule();
    });
  }

  function pump() {
    if (!outgoing.length || buildError) return;
    if (!child) {
      const delay = RESTART_MS - (performance.now() - lastSpawn);
      if (delay > 0) {
        if (restartTimer === null) restartTimer = setTimeout(() => {
          restartTimer = null;
          pump();
        }, Math.ceil(delay));
        return;
      }
      try { launch(); } catch (error) {
        reset(new Error(`flmouse failed to start: ${error.message}`));
        return;
      }
    }
    while (!blocked && outgoing.length) {
      const entry = outgoing[0];
      // AX walks can outlast ordinary command timeouts; keep them as queue barriers.
      if (pending.some((item) => item.op === 'ax_list')
        || (entry.op === 'ax_list' && pending.length)) break;
      // One move in flight plus one replaceable unsent move bounds move traffic.
      if (entry.op === 'move' && pending.some((item) => item.op === 'move')) break;
      outgoing.shift();
      if (waitingMove === entry) waitingMove = null;
      pending.push(entry);
      for (const waiter of entry.waiters) waiter.start();
      try { blocked = !child.stdin.write(entry.line); } catch (error) {
        reset(new Error(`flmouse write failed: ${error.message}`));
        return;
      }
    }
  }

  function schedule() {
    if (scheduled !== null || !outgoing.length) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      pump();
    });
  }

  function command(op, fields = {}, timeoutMs = TIMEOUT_MS) {
    if (buildError) return Promise.reject(buildError);
    let line;
    try { line = `${JSON.stringify({ op, ...fields })}\n`; } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let entry = op === 'move' ? waitingMove : null;
      if (entry) entry.line = line;
      else {
        entry = { op, line, waiters: new Set() };
        outgoing.push(entry);
        if (op === 'move') waitingMove = entry;
      }
      const waiter = { resolve, reject, timer: null };
      entry.waiters.add(waiter);
      // Queued commands must not time out while an earlier AX walk is still running.
      waiter.start = () => {
        waiter.timer = setTimeout(() => {
          entry.waiters.delete(waiter);
          const error = new Error(`flmouse ${op} timed out after ${timeoutMs}ms`);
          reject(error);
          if (entry.waiters.size) return;
          // Reset the stream so late replies cannot be misattributed.
          reset(error);
        }, timeoutMs);
      };
      schedule();
    });
  }

  if (!buildError) {
    try { launch(); } catch (error) {
      report(`flmouse failed to start: ${error.message}`);
    }
  }

  return {
    ping: () => command('ping'),
    screen: () => command('screen'),
    pos: () => command('pos'),
    axList: ({ max = 60, budgetMs = 350 } = {}) =>
      command('ax_list', { max, budget_ms: budgetMs }, budgetMs + 1500),
    move: (x, y) => command('move', { x, y }),
    click: (button = 'left', count = 1) => command('click', { button, count }),
    down: (button = 'left') => command('down', { button }),
    up: (button = 'left') => command('up', { button }),
    scroll: (dx, dy) => command('scroll', { dx, dy }),
    key: (code, flags = []) => command('key', { code, flags }),
    stop: () => {
      reset(new Error('flmouse stopped'));
      return buildError ? Promise.reject(buildError) : Promise.resolve({ ok: true });
    },
  };
}
