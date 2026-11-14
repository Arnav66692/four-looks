import assert from 'node:assert/strict';
import { startMouse } from './mouse.js';

const mouse = startMouse({ dry: true });
let failures = 0;

async function check(name, run) {
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

process.exitCode = failures ? 1 : 0;
