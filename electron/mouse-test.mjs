import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { startMouse } from './mouse.js';

const mouse = startMouse({ dry: true });
let failures = 0;
let checks = 0;

async function check(name, run) {
  checks += 1;
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

try {
  await check('ping replies ok', async () => {
    assert.equal((await mouse.ping()).ok, true);
  });
  await check('screen replies ok', async () => {
    assert.equal((await mouse.screen()).ok, true);
  });
  await check('axList returns dry accessibility elements with centre coordinates', async () => {
    const reply = await mouse.axList();
    assert.deepEqual(Object.keys(reply).sort(), ['app', 'elements', 'ms', 'ok', 'truncated', 'window']);
    assert.equal(reply.ok, true);
    assert.equal(typeof reply.app, 'string');
    assert.equal(typeof reply.window, 'string');
    assert.equal(reply.truncated, false);
    assert.equal(typeof reply.ms, 'number');
    assert.ok(Number.isFinite(reply.ms) && reply.ms >= 0);
    assert.equal(reply.elements.length, 3);
    reply.elements.forEach((element, index) => {
      assert.deepEqual(Object.keys(element).sort(), ['h', 'id', 'name', 'role', 'w', 'x', 'y']);
      assert.equal(element.id, index + 1);
      assert.equal(typeof element.role, 'string');
      assert.equal(typeof element.name, 'string');
      for (const key of ['x', 'y', 'w', 'h']) {
        assert.equal(typeof element[key], 'number');
        assert.ok(Number.isFinite(element[key]));
      }
    });
    assert.equal(reply.elements[0].x, 990);
    assert.equal(reply.elements[0].y, 330);
  });
  await check('axList options and interleaved moves preserve distinct replies', async () => {
    const replies = await Promise.all([
      mouse.move(1, 2), mouse.axList({ max: 1, budgetMs: 2500 }),
      mouse.move(3, 4), mouse.axList({ max: 2, budgetMs: 500 }),
    ]);
    assert.equal(replies[0].ok, true);
    assert.equal(replies[2].ok, true);
    assert.equal(replies[1].elements.length, 1);
    assert.equal(replies[3].elements.length, 2);
    assert.equal(replies[1].truncated, true);
    assert.equal(replies[3].truncated, true);
  });
  await check('AX barrier defers later command timers and uses budget plus 1500ms', async () => {
    const helper = new EventEmitter();
    helper.stdout = new PassThrough();
    helper.stderr = new PassThrough();
    helper.exitCode = helper.signalCode = null;
    helper.kill = () => { helper.signalCode = 'SIGTERM'; };
    const sent = [];
    helper.stdin = new Writable({
      write(chunk, encoding, done) {
        sent.push(JSON.parse(chunk.toString()));
        done();
      },
    });
    const originalSpawn = childProcess.spawn;
    let queued;
    try {
      childProcess.spawn = () => helper;
      syncBuiltinESMExports();
      queued = startMouse({ dry: true });
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    const originalTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
      delays.push(delay);
      return originalTimeout(callback, delay, ...args);
    };
    try {
      const ax = queued.axList({ budgetMs: 3500 });
      const ping = queued.ping();
      // Attach rejection handlers immediately, including on assertion failure.
      const results = Promise.all([ax, ping]);
      results.catch(() => {});
      await new Promise(setImmediate);
      assert.deepEqual(sent, [{ op: 'ax_list', max: 60, budget_ms: 3500 }]);
      assert.deepEqual(delays, [5000]);
      helper.stdout.write('{"ok":true,"elements":[]}\n');
      await new Promise(setImmediate);
      assert.equal(sent[1].op, 'ping');
      assert.deepEqual(delays, [5000, 2000]);
      helper.stdout.write('{"ok":true,"trusted":false}\n');
      assert.equal((await results)[1].ok, true);
    } finally {
      globalThis.setTimeout = originalTimeout;
      await queued.stop();
    }
  });
  await check('200 rapid moves settle and helper stays responsive', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, index) => mouse.move(index, index)),
    );
    assert.equal(results.length, 200);
    for (const result of results) {
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.equal(result.value.ok, true);
    }
    assert.equal((await mouse.ping()).ok, true);
  });
  await check('dry left click once replies ok', async () => {
    const reply = await mouse.click('left', 1);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });
  await check('dry right click twice replies ok', async () => {
    const reply = await mouse.click('right', 2);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });
  await check('bad button replies ok false', async () => {
    assert.equal((await mouse.click('bad-button')).ok, false);
  });
  await check('command after stop respawns and works', async () => {
    assert.equal((await mouse.stop()).ok, true);
    assert.equal((await mouse.ping()).ok, true);
  });
} finally {
  await mouse.stop().catch(() => {});
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
