import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.js';
import { route } from './router.js';

let failures = 0, passes = 0;
async function check(name, test) {
  try { await test(); passes++; console.log(`PASS ${name}`); } catch {
    // Do not echo arbitrary model/HTTP payloads or secrets when an assertion fails.
    failures++;
    console.log(`FAIL ${name}`);
  }
}
let nextId = 0;
const call = (name, args = {}) => ({ role: 'assistant', tool_calls: [{
  id: `step-${++nextId}`, type: 'function',
  function: { name, arguments: JSON.stringify({ reason: 'Navigate the screen', irreversible: false, ...args }) },
}] });
function fixture(script, overrides = {}) {
  const events = [], steps = [], confirmations = [], requests = [];
  if (script[0]?.tool_calls?.[0]?.function.name === 'click') script = [call('look'), ...script];
  const mouse = {
    screen: async () => ({ width: 1000, height: 500 }),
    pos: async () => ({ x: 0, y: 0 }),
    move: async (...args) => { events.push(['move', ...args]); },
    click: async (...args) => { events.push(['click', ...args]); },
    key: async (...args) => { events.push(['key', ...args]); },
    scroll: async (...args) => { events.push(['scroll', ...args]); },
  };
  let cursor = 0;
  const agent = createAgent({
    openUrl: async (url) => { events.push(['open_url', url]); },
    openApp: async (name) => { events.push(['open_app', name]); }, frontApp: async () => 'Safari',
    mouse, typeText: async (text) => { events.push(['type', text]); },
    screenshot: async () => ({ pngBase64: 'ZmFrZQ==', width: 2000, height: 1000 }),
    ask: async (messages, tools) => {
      requests.push(structuredClone({ messages, tools }));
      return script[Math.min(cursor++, script.length - 1)];
    },
    onStep: (info) => { steps.push(info); },
    confirm: async (description) => { confirmations.push(description); return false; },
    ...overrides,
  });
  return { agent, mouse, events, steps, confirmations, requests };
}

await check('click, type, done scale coordinates and glide', async () => {
  const f = fixture([call('click', { x: 1000, y: 500, button: 'right', double: true }), call('type', { text: 'San Diego weather' }), call('done', { summary: 'Search entered' })]);
  const result = await f.agent.run('Find the weather on this page');
  assert.equal(result.ok, true);
  assert.equal(result.steps, 4);
  assert.equal(result.summary, 'Search entered');
  assert.equal(result.stoppedWhy, null);
  assert.equal(result.modelCalls, 4);
  assert.equal(result.routed, false);
  assert.ok(result.modelMs >= 0 && result.totalMs >= result.modelMs);
  assert.equal(f.events.filter(([name]) => name === 'move').length, 8);
  assert.deepEqual(f.events.at(7), ['move', 500, 250]);
  assert.deepEqual(f.events.slice(8), [['click', 'right', 2], ['type', 'San Diego weather']]);
  assert.equal(f.steps.find((s) => s.action === 'click').x, 500);
  assert.equal(f.steps.find((s) => s.action === 'click').y, 250);
  assert.equal(f.requests[1].messages.at(-1).content[1].image_url.url, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(f.requests[1].messages.at(-2).role, 'tool');
  assert.equal(f.requests[1].messages.filter((m) => Array.isArray(m.content)).length, 1);
});

await check('irreversible flag asks and skips declined action', async () => {
  const f = fixture([call('click', { x: 10, y: 10, irreversible: true })]);
  const result = await f.agent.run('Navigate');
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.events.length, 0);
  assert.equal(result.stoppedWhy, 'Confirmation declined');
});

await check('Send label overrides false irreversible flag', async () => {
  const f = fixture([call('click', { x: 20, y: 30, label: 'Send', reason: 'Click the blue button' })]);
  assert.equal((await f.agent.run('Draft a note')).ok, false);
  assert.match(f.confirmations[0], /Send/);
  assert.equal(f.events.length, 0);
});

await check('all required destructive labels ask independently', async () => {
  for (const label of ['Submit', 'Post', 'Buy', 'Pay', 'Place order', 'Delete', 'Remove', 'Confirm', "Don't Save", 'Don’t Save', 'Do not save', 'Discard', 'Empty Trash']) {
    const f = fixture([call('click', { x: 20, y: 30, reason: `Click ${label}` })]);
    assert.equal((await f.agent.run('Navigate')).stoppedWhy, 'Confirmation declined');
    assert.equal(f.confirmations.length, 1);
    assert.equal(f.events.length, 0);
  }
});

await check('password request is refused without typing', async () => {
  const f = fixture([call('type', { text: 'example-secret', inputKind: 'plain' })]);
  const result = await f.agent.run('Type a password into the login field');
  assert.equal(result.stoppedWhy, 'Sensitive text refused');
  assert.match(result.summary, /Refused/);
  assert.equal(f.events.length, 0);
});

await check('sensitive field, card digits and one-time codes refused', async () => {
  for (const args of [{ text: 'opaque-value', inputKind: 'password' }, { text: 'opaque-value', context: 'Password field' }, { text: '4111 1111 1111 1111' }, { text: '123456' }]) {
    const f = fixture([call('type', args)]);
    assert.equal((await f.agent.run('Fill this field')).stoppedWhy, 'Sensitive text refused');
    assert.equal(f.events.length, 0);
  }
});

await check('Return, closing, command-return and newline require confirmation', async () => {
  for (const message of [call('key', { name: 'return', context: 'compose' }), call('key', { name: 'cmd+return' }), call('key', { name: 'cmd+w' }), call('type', { text: 'hello\n' })]) {
    const f = fixture([message]);
    assert.equal((await f.agent.run('Navigate')).stoppedWhy, 'Confirmation declined');
    assert.equal(f.events.length, 0);
  }
});

await check('approved action runs and key codes match mouse transport', async () => {
  const f = fixture([call('key', { name: 'return' }), call('key', { name: 'cmd+l' }), call('scroll', { dy: -120 }), call('done', { summary: 'Finished' })], { confirm: async () => true });
  assert.equal((await f.agent.run('Navigate')).ok, true);
  assert.deepEqual(f.events, [['key', 36, []], ['key', 37, ['cmd']], ['scroll', 0, -120]]);
});

await check('click clamps to main display points', async () => {
  const f = fixture([call('click', { x: -999, y: 99999 }), call('done', { summary: 'Finished' })]);
  assert.equal((await f.agent.run('Navigate')).ok, true);
  assert.deepEqual(f.events.at(7), ['move', 0, 499]);
  assert.ok(f.events.filter(([name]) => name === 'move').every(([, x, y]) => x >= 0 && x < 1000 && y >= 0 && y < 500));
});

await check('maxSteps stops a repeating loop', async () => {
  const f = fixture([call('wait', { ms: 0 })], { maxSteps: 2 });
  const result = await f.agent.run('Navigate');
  assert.equal(result.steps, 2);
  assert.equal(result.stoppedWhy, 'maxSteps reached');
});

await check('stop during ask prevents subsequent events', async () => {
  let f;
  f = fixture([], { ask: async () => { f.agent.stop(); return call('type', { text: 'hello' }); } });
  assert.equal((await f.agent.run('Navigate')).stoppedWhy, 'Stopped by person');
  assert.equal(f.events.length, 0);
});

await check('stop during glide prevents click', async () => {
  const f = fixture([call('click', { x: 10, y: 10 })]);
  f.mouse.move = async (...args) => { f.events.push(['move', ...args]); f.agent.stop(); };
  assert.equal((await f.agent.run('Navigate')).stoppedWhy, 'Stopped by person');
  assert.equal(f.events.length, 1);
});

await check('malformed model outputs never escape run', async () => {
  const bad = [null, {}, { content: 'click here' }, call('unsupported'), call('click', { x: '4', y: 3 }), call('click', { x: 4, y: 3, button: 'middle' }), call('scroll', { dy: 0.5 }), call('wait', { ms: -1 }), call('key', { name: 'cmd+q' })];
  const malformed = call('type', { text: 'hello' }); malformed.tool_calls[0].function.arguments = '{'; bad.push(malformed);
  const missingFlag = call('wait', { ms: 0 }); missingFlag.tool_calls[0].function.arguments = '{"ms":0,"reason":"wait"}'; bad.push(missingFlag);
  for (const message of bad) {
    const f = fixture([message]);
    const result = await f.agent.run('Navigate');
    assert.equal(result.ok, false);
    assert.equal(typeof result.stoppedWhy, 'string');
    assert.equal(f.events.length, 0);
  }
});

await check('screenshot, callback and ask failures are reported', async () => {
  for (const overrides of [{ screenshot: async () => { throw new Error('Capture unavailable'); } }, { ask: async () => { throw new Error('Request unavailable'); } }, { onStep: () => { throw new Error('UI unavailable'); } }, { screenSize: { width: 0, height: 0 } }]) {
    const f = fixture([call('look')], overrides);
    assert.equal((await f.agent.run('Navigate')).ok, false);
    assert.equal(f.events.length, 0);
  }
});

await check('ask_person waits for a yes/no answer', async () => {
  const f = fixture([call('ask_person', { question: 'Continue?' }), call('done', { summary: 'Finished' })], { confirm: async (question) => question === 'Continue?' });
  assert.equal((await f.agent.run('Navigate')).ok, true);
  assert.equal(f.events.length, 0);
});

await check('native resolved failures stop before further actions', async () => {
  const f = fixture([call('click', { x: 10, y: 20 }), call('done', { summary: 'Finished' })]);
  f.mouse.move = async () => ({ ok: false, error: 'accessibility' });
  const result = await f.agent.run('Navigate');
  assert.equal(result.ok, false);
  assert.match(result.stoppedWhy, /Operation failed/);
  assert.equal(f.events.length, 0);
  assert.equal(f.requests.length, 2);
});

const batch = (...messages) => ({ role: 'assistant', tool_calls: messages.flatMap((m) => m.tool_calls) });
const firstAction = (goal) => route(goal)?.actions[0];

for (const [site, host] of Object.entries({
  gmail: 'mail.google.com', google: 'www.google.com', youtube: 'www.youtube.com',
  'google calendar': 'calendar.google.com', 'google drive': 'drive.google.com',
  'google docs': 'docs.google.com', 'google maps': 'maps.google.com', github: 'github.com',
  devpost: 'devpost.com', chatgpt: 'chatgpt.com', grok: 'grok.com', x: 'x.com', twitter: 'x.com',
  reddit: 'www.reddit.com', wikipedia: 'www.wikipedia.org', amazon: 'www.amazon.com',
  netflix: 'www.netflix.com', spotify: 'open.spotify.com', linkedin: 'www.linkedin.com',
  slack: 'app.slack.com', notion: 'www.notion.so', canvas: 'canvas.instructure.com',
})) {
  await check(`route site ${site}`, () => {
    for (const verb of ['open', 'go to', 'launch', 'pull up']) {
      assert.deepEqual(firstAction(`Please ${verb} ${site.toUpperCase()}, please!`), { name: 'open_url', args: { url: `https://${host}` } });
    }
  });
}
for (const [app, name] of Object.entries({
  chrome: 'Google Chrome', 'google chrome': 'Google Chrome', safari: 'Safari', notes: 'Notes',
  messages: 'Messages', mail: 'Mail', finder: 'Finder', calendar: 'Calendar', terminal: 'Terminal',
  spotify: 'Spotify', slack: 'Slack', settings: 'System Settings', 'system settings': 'System Settings',
  textedit: 'TextEdit', music: 'Music', photos: 'Photos', maps: 'Maps', cursor: 'Cursor',
  discord: 'Discord', zoom: 'zoom.us',
})) {
  await check(`route app ${app}`, () => {
    assert.deepEqual(firstAction(`Launch ${app} app!`), { name: 'open_app', args: { name } });
    assert.deepEqual(firstAction(`Open the app ${app}!`), { name: 'open_app', args: { name } });
    if (!['slack', 'spotify'].includes(app)) assert.equal(firstAction(`Open ${app}`).args.name, name);
  });
}

await check('route search families encode queries', () => {
  for (const goal of ['search red fox & bear', 'search for red fox & bear', 'google red fox & bear', 'look up red fox & bear']) {
    assert.equal(firstAction(goal).args.url, 'https://www.google.com/search?q=red%20fox%20%26%20bear');
  }
  for (const goal of ['youtube red fox', 'search youtube for red fox']) {
    assert.equal(firstAction(goal).args.url, 'https://www.youtube.com/results?search_query=red%20fox');
  }
  const wiki = new URL(firstAction('wikipedia red fox').args.url);
  assert.equal(wiki.hostname, 'en.wikipedia.org'); assert.equal(wiki.searchParams.get('search'), 'red fox');
  const directions = new URL(firstAction('directions to San Diego').args.url);
  assert.equal(directions.searchParams.get('destination'), 'San Diego');
  const map = new URL(firstAction('map of San Diego').args.url);
  assert.equal(map.searchParams.get('query'), 'San Diego');
});

await check('route URLs, bare domains and unsafe schemes', () => {
  for (const [goal, url] of [['example.com', 'https://example.com/'], ['example.com/path?q=hello', 'https://example.com/path?q=hello'], ['https://example.com/a', 'https://example.com/a'], ['http://example.com', 'http://example.com/']]) {
    assert.deepEqual(firstAction(goal), { name: 'open_url', args: { url } });
  }
  assert.equal(firstAction('open https://example.com/MyPage').args.url, 'https://example.com/MyPage');
  for (const goal of ['file:///tmp/a', 'javascript:alert(1)', 'ftp://example.com', 'https://person:secret@example.com']) assert.equal(route(goal), null);
});

await check('route email draft variants preserve encoded fields and never claim sent', () => {
  for (const verb of ['email to', 'mail to', 'compose an email to', 'email', 'mail']) {
    for (const marker of ['saying', 'that says', 'body', ':']) {
      const draft = route(`${verb} alex@example.com subject Lunch & tea ${marker} Meet at 3:30!`);
      const url = new URL(draft.actions[0].args.url);
      assert.equal(url.origin + url.pathname, 'https://mail.google.com/mail/');
      assert.equal(url.searchParams.get('to'), 'alex@example.com');
      assert.equal(url.searchParams.get('su'), 'Lunch & tea');
      assert.equal(url.searchParams.get('body'), 'Meet at 3:30!');
      assert.match(draft.summary, /draft is open/i); assert.match(draft.summary, /nothing was sent/i);
    }
  }
  const url = new URL(firstAction('email to alex@example.com saying Hello').args.url);
  assert.equal(url.searchParams.get('su'), '');
  assert.equal(url.searchParams.get('body'), 'Hello');
  assert.equal(route('email to alex@example.com saying Hello and send it'), null);
});

await check('route shortcuts, scroll, text and chained commands', () => {
  for (const [goal, name] of Object.entries({ 'new tab': 'cmd+t', 'switch app': 'cmd+tab', 'switch window': 'cmd+tab', 'go back': 'cmd+[', 'go forward': 'cmd+]', refresh: 'cmd+r', reload: 'cmd+r', 'select all': 'cmd+a', copy: 'cmd+c', paste: 'cmd+v', undo: 'cmd+z', spotlight: 'cmd+space' })) {
    assert.deepEqual(firstAction(`${goal}!`), { name: 'key', args: { name } });
  }
  assert.ok(firstAction('scroll down').args.dy < 0);
  assert.ok(firstAction('scroll up').args.dy > 0);
  assert.deepEqual(firstAction('type Hello, world!'), { name: 'type', args: { text: 'Hello, world!' } });
  for (const separator of [' and then ', ' then ', ', then ']) {
    assert.deepEqual(route(`open gmail${separator}new tab`).actions.map((a) => a.name), ['open_url', 'key']);
    assert.equal(route(`open gmail${separator}do something mysterious`), null);
  }
});

await check('route refuses risky words, closing and unknown goals', () => {
  for (const word of ['send', 'submit', 'post', 'buy', 'pay', 'order', 'delete', 'remove', 'password', 'card', 'code']) {
    assert.equal(route(`search ${word}`), null);
    assert.equal(route(`open gmail then type ${word}`), null);
  }
  for (const goal of ['close tab', 'close window', 'open unknown app', '', 'open gmail then ', 'open vs code', 'open visual studio code']) assert.equal(route(goal), null);
  assert.equal(route(null), null);
});

await check('routed actions need zero ask calls, captures or front app requests', async () => {
  const f = fixture([], { screenshot: async () => { throw new Error('Should not capture'); }, frontApp: async () => { throw new Error('Should not query app'); } });
  const result = await f.agent.run('open gmail then open notes app then type Hello');
  assert.equal(result.ok, true); assert.equal(result.routed, true); assert.equal(result.modelCalls, 0); assert.equal(result.modelMs, 0);
  assert.equal(f.requests.length, 0); assert.equal(result.steps, 3);
  assert.deepEqual(f.events, [['open_url', 'https://mail.google.com'], ['open_app', 'Notes'], ['type', 'Hello']]);
  assert.equal(f.steps.at(-1).text, 'Hello');
});

await check('encoded draft fields cannot bypass card and OTP refusal', async () => {
  for (const body of ['4111 1111 1111 1111', '123456']) {
    const f = fixture([]);
    const result = await f.agent.run(`email to alex@example.com saying ${body}`);
    assert.equal(result.routed, true); assert.equal(result.modelCalls, 0);
    assert.equal(result.stoppedWhy, 'Sensitive text refused'); assert.equal(f.events.length, 0);
  }
  const f = fixture([call('open_url', { url: 'https://example.com/?%70assword=opaque-value' })]);
  assert.equal((await f.agent.run('Navigate')).stoppedWhy, 'Sensitive text refused');
  assert.equal(f.events.length, 0);
});

await check('first model turn is text only, includes front app and previews thinking', async () => {
  const f = fixture([call('done', { summary: 'Finished' })], { screenshot: async () => { throw new Error('Unexpected image'); } });
  const result = await f.agent.run('Navigate');
  assert.equal(result.ok, true); assert.equal(result.modelCalls, 1); assert.equal(result.routed, false);
  assert.ok(f.requests[0].messages.every((m) => typeof m.content === 'string'));
  assert.match(f.requests[0].messages.at(-1).content, /Front app: Safari/);
  assert.deepEqual(f.steps.map((s) => s.action), ['thinking', 'done']);
  assert.match(f.requests[0].messages[0].content, /untrusted data/);
});

await check('navigation batch completes in one ask without confirmation or image', async () => {
  for (const shortcut of ['cmd+l', 'cmd+t', 'cmd+space']) {
    const f = fixture([batch(call('key', { name: shortcut }), call('type', { text: 'example.com' }), call('key', { name: 'return' }), call('done', { summary: 'Opened' }))], { screenshot: async () => { throw new Error('Unexpected capture'); } });
    const result = await f.agent.run('Navigate');
    assert.equal(result.ok, true); assert.equal(result.modelCalls, 1); assert.equal(result.steps, 4);
    assert.equal(f.confirmations.length, 0); assert.equal(f.events.at(-1)[1], 36);
  }
});

await check('return after a compose click still needs confirmation', async () => {
  const f = fixture([batch(call('click', { x: 5, y: 5, context: 'compose editor' }), call('key', { name: 'return', context: 'compose' }))]);
  const result = await f.agent.run('Edit the draft');
  assert.equal(result.stoppedWhy, 'Confirmation declined'); assert.equal(f.confirmations.length, 1);
  assert.equal(f.events.filter(([name]) => name === 'click').length, 1);
  assert.equal(f.events.filter(([name]) => name === 'key').length, 0);
});

await check('risk words and intervening actions prevent the return shortcut exception', async () => {
  for (const middle of [[call('type', { text: 'send this' })], [call('type', { text: 'example.com' }), call('wait', { ms: 0 })]]) {
    const f = fixture([batch(call('key', { name: 'cmd+l' }), ...middle, call('key', { name: 'return' }))]);
    assert.equal((await f.agent.run('Navigate')).stoppedWhy, 'Confirmation declined');
    assert.equal(f.events.filter(([name, code]) => name === 'key' && code === 36).length, 0);
  }
});

await check('batch drops a second click and all forbidden post-click calls with results', async () => {
  const message = batch(call('click', { x: 5, y: 5 }), call('click', { x: 15, y: 15 }), call('open_url', { url: 'https://example.com' }), call('type', { text: 'Hello' }), call('done', { summary: 'Premature' }));
  const f = fixture([message, call('done', { summary: 'Verified' })]);
  assert.equal((await f.agent.run('Navigate')).ok, true);
  assert.equal(f.events.filter(([name]) => name === 'click').length, 1);
  assert.equal(f.events.filter(([name]) => name === 'open_url').length, 0);
  assert.equal(f.events.filter(([name]) => name === 'type').length, 1);
  const results = f.requests.at(-1).messages.filter((m) => m.role === 'tool' && message.tool_calls.some((c) => c.id === m.tool_call_id));
  assert.equal(results.length, 5);
  assert.equal(results.filter((m) => /Dropped/.test(m.content)).length, 3);
  assert.ok(results.every((m) => /Ran calls:/.test(m.content)));
});

await check('host caps batches at six calls and answers all tool calls', async () => {
  const message = batch(...Array.from({ length: 7 }, () => call('key', { name: 'tab' })));
  const f = fixture([message, call('done', { summary: 'Finished' })]);
  assert.equal((await f.agent.run('Navigate')).ok, true);
  assert.equal(f.events.length, 6);
  const results = f.requests[1].messages.filter((m) => m.role === 'tool');
  assert.equal(results.length, 7); assert.match(results.at(-1).content, /Dropped: at most six/);
});

await check('open_url rejects file and javascript and accepts HTTP(S)', async () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://person:secret@example.com']) {
    const f = fixture([call('open_url', { url })]);
    assert.equal((await f.agent.run('Navigate')).ok, false); assert.equal(f.events.length, 0);
  }
  const f = fixture([batch(call('open_url', { url: 'https://example.com' }), call('open_app', { name: 'Notes' }), call('done', { summary: 'Opened' }))]);
  assert.equal((await f.agent.run('Navigate')).ok, true);
  assert.deepEqual(f.events, [['open_url', 'https://example.com'], ['open_app', 'Notes']]);
});

await check('look attaches JPEG on the next turn and retains complete tool history', async () => {
  let captures = 0;
  const f = fixture([call('look'), call('done', { summary: 'Seen' })], { screenshot: async () => { captures++; return { base64: 'ZmFrZQ==', mime: 'image/jpeg', width: 2000, height: 1000 }; } });
  assert.equal((await f.agent.run('Inspect the current view')).ok, true);
  assert.equal(captures, 1);
  assert.ok(f.requests[0].messages.every((m) => !Array.isArray(m.content)));
  assert.equal(f.requests[1].messages.at(-1).content[1].image_url.url, 'data:image/jpeg;base64,ZmFrZQ==');
  assert.equal(f.requests[1].messages.at(-2).role, 'tool');
});

await check('paste and delete run without confirmation but refuse sensitive contexts', async () => {
  const f = fixture([batch(call('key', { name: 'delete' }), call('key', { name: 'cmd+v' }), call('done', { summary: 'Finished' }))]);
  assert.equal((await f.agent.run('Navigate')).ok, true); assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.events, [['key', 51, []], ['key', 9, ['cmd']]]);
  for (const name of ['delete', 'cmd+v']) {
    const secret = fixture([call('key', { name, context: 'password field' })]);
    assert.equal((await secret.agent.run('Navigate')).stoppedWhy, 'Sensitive text refused');
    assert.equal(secret.events.length, 0);
  }
});

await check('new macOS key codes match the native transport', async () => {
  for (const [name, code, flags] of [['cmd+[', 33, ['cmd']], ['cmd+]', 30, ['cmd']], ['cmd+r', 15, ['cmd']], ['cmd+z', 6, ['cmd']], ['cmd+n', 45, ['cmd']], ['cmd+f', 3, ['cmd']], ['cmd+return', 36, ['cmd']], ['shift+tab', 48, ['shift']], ['pageup', 116, []], ['pagedown', 121, []]]) {
    const f = fixture([batch(call('key', { name }), call('done', { summary: 'Finished' }))], { confirm: async () => true });
    assert.equal((await f.agent.run('Navigate')).ok, true); assert.deepEqual(f.events[0], ['key', code, flags]);
  }
});

await check('first-turn click captures dimensions lazily and still enforces one click per batch', async () => {
  const message = batch(call('click', { x: 10, y: 10 }), call('click', { x: 20, y: 20 }));
  const f = fixture([call('wait', { ms: 0 }), call('done', { summary: 'Finished' })]);
  let count = 0, captures = 0;
  const agent = createAgent({ mouse: f.mouse, screenshot: async () => { captures++; return { pngBase64: 'ZmFrZQ==', width: 1000, height: 500 }; }, ask: async (messages) => {
    if (++count === 1) { assert.ok(messages.every((m) => !Array.isArray(m.content))); return message; }
    return call('done', { summary: 'Seen' });
  } });
  assert.equal((await agent.run('Navigate')).ok, true);
  assert.equal(f.events.filter(([name]) => name === 'click').length, 1);
  assert.equal(captures, 2);
});

await check('only requested delays are used for glide, input and screenshot settling', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    delays.push(ms);
    return realSetTimeout(callback, 0, ...args);
  };
  try {
    const f = fixture([batch(call('click', { x: 5, y: 5 }), call('type', { text: 'Hello' }), call('key', { name: 'tab' })), call('done', { summary: 'Finished' })]);
    assert.equal((await f.agent.run('Navigate')).ok, true);
    assert.equal(delays.filter((ms) => ms === 15).length, 8);
    assert.equal(delays.filter((ms) => ms === 80).length, 2);
    assert.equal(delays.length, 11);
    assert.ok(delays.at(-1) > 250 && delays.at(-1) <= 350);
    for (const message of [call('open_url', { url: 'https://example.com' }), call('open_app', { name: 'Notes' })]) {
      delays.length = 0;
      // Opening a link or an app alone finishes the run: no settle wait and no second model call.
      const opened = fixture([message, call('done', { summary: 'Opened' })]);
      const result = await opened.agent.run('Navigate');
      assert.equal(result.ok, true);
      assert.equal(result.modelCalls, 1);
      assert.deepEqual(delays, []);
      // With a key press after it the run goes on, and the next screenshot waits for the page to settle.
      delays.length = 0;
      const more = fixture([batch(message.tool_calls[0] && message, call('key', { name: 'tab' })), call('done', { summary: 'Opened' })]);
      assert.equal((await more.agent.run('Navigate')).ok, true);
      assert.ok(delays.some((ms) => ms > 150 && ms <= 350));
    }
    delays.length = 0;
    const immediate = fixture([batch(call('open_url', { url: 'https://example.com' }), call('done', { summary: 'Opened' }))]);
    assert.equal((await immediate.agent.run('Navigate')).ok, true);
    assert.deepEqual(delays, []);
  } finally { globalThis.setTimeout = realSetTimeout; }
});

// Mock built-in filesystem bindings and fetch: no real requests, key, ledger writes or events.
const original = { fetch: globalThis.fetch, read: fs.readFileSync, write: fs.writeFileSync };
const usagePath = fileURLToPath(new URL('../.usage.json', import.meta.url));
const savedEnv = Object.fromEntries(['FL_MAX_USD', 'FL_MAX_CALLS_PER_DAY', 'XAI_VISION_MODEL', 'XAI_AGENT_MODEL'].map((name) => [name, process.env[name]]));
let ledger, requests = [];
const resetLedger = () => { ledger = { usd: 0, calls: 0, inTokens: 0, outTokens: 0, day: '', callsToday: 0 }; requests = []; process.env.FL_MAX_USD = '1'; process.env.FL_MAX_CALLS_PER_DAY = '300'; delete process.env.XAI_VISION_MODEL; delete process.env.XAI_AGENT_MODEL; };
fs.readFileSync = (path, ...args) => String(path) === usagePath ? JSON.stringify(ledger) : original.read(path, ...args);
fs.writeFileSync = (path, data, ...args) => {
  if (String(path) === usagePath) { ledger = JSON.parse(data); return; }
  throw new Error('Unexpected test write refused');
};
syncBuiltinESMExports();
try {
  const { chooseVisionModel, chooseTextModel, askGrok, overBudget, addUsage } = await import('./xai.js');
  const fakeKey = 'offline-test-placeholder';
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
  const options = { key: fakeKey, model: 'grok-4.3', messages: [{ role: 'user', content: 'test' }], tools: [] };

  await check('vision model selection uses list, override and flagship fallback', async () => {
    resetLedger();
    globalThis.fetch = async (url) => { requests.push(url); return reply({ data: [{ id: 'grok-4.3' }, { id: 'grok-4' }] }); };
    assert.equal(await chooseVisionModel(fakeKey), 'grok-4');
    process.env.XAI_VISION_MODEL = 'grok-4.3';
    assert.equal(await chooseVisionModel(fakeKey), 'grok-4.3');
    delete process.env.XAI_VISION_MODEL;
    globalThis.fetch = async () => reply({ data: [{ id: 'grok-4.3' }] });
    assert.equal(await chooseVisionModel(fakeKey), 'grok-4.3');
    assert.equal(requests[0], 'https://api.x.ai/v1/models');
  });

  await check('askGrok uses compatible tools format and records usage', async () => {
    resetLedger();
    const message = call('done', { summary: 'Finished' });
    globalThis.fetch = async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return reply({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } }); };
    assert.deepEqual((await askGrok(options)).message, message);
    assert.equal(requests[0].url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(requests[0].body.tool_choice, 'required');
    assert.equal(requests[0].body.parallel_tool_calls, true);
    assert.equal(requests[0].body.max_tokens, 500);
    assert.equal(requests[0].body.temperature, 0);
    assert.equal(ledger.calls, 1);
    assert.equal(ledger.inTokens, 100);
    assert.equal(ledger.usd, (100 * 1.25 + 20 * 2.5) / 1e6);
  });

  await check('grok-4.7 preference and shared text model avoid another discovery request', async () => {
    resetLedger();
    let discoveries = 0;
    globalThis.fetch = async () => {
      discoveries++;
      return reply({ data: [{ id: 'older-image-model', input_modalities: ['image'] }, { id: 'grok-4.7' }, { id: 'grok-4' }] });
    };
    const vision = await chooseVisionModel(fakeKey);
    assert.equal(vision, 'grok-4.7');
    assert.equal(await chooseTextModel(fakeKey, vision), vision);
    assert.equal(discoveries, 1);
    assert.equal(await chooseTextModel(fakeKey), vision);
    process.env.XAI_AGENT_MODEL = 'custom-text-model';
    assert.equal(await chooseTextModel(fakeKey, vision), 'custom-text-model');
    process.env.XAI_VISION_MODEL = 'grok-4';
    assert.equal(await chooseVisionModel(fakeKey), 'grok-4');
    process.env.XAI_VISION_MODEL = 'missing-model';
    await assert.rejects(chooseVisionModel(fakeKey), /not available/);
  });

  await check('askGrok exposes timing, accepts tuning, and prices unknown models conservatively', async () => {
    resetLedger();
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return reply({ choices: [{ message: call('done', { summary: 'Finished' }) }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    };
    const response = await askGrok({ ...options, model: 'grok-4.7', temperature: 0.25, maxTokens: 123 });
    assert.equal(typeof response.ms, 'number'); assert.ok(response.ms >= 0);
    assert.deepEqual(response.usage, { prompt_tokens: 100, completion_tokens: 50 });
    assert.equal(requests[0].temperature, 0.25); assert.equal(requests[0].max_tokens, 123);
    assert.equal(ledger.usd, (100 * 2 + 50 * 6) / 1e6);
    addUsage('unknown-future-model', { prompt_tokens: 100, completion_tokens: 50 });
    assert.equal(ledger.usd, 2 * (100 * 2 + 50 * 6) / 1e6);
    addUsage('__proto__', { prompt_tokens: 100, completion_tokens: 50 });
    assert.equal(ledger.usd, 3 * (100 * 2 + 50 * 6) / 1e6);
    await assert.rejects(askGrok({ ...options, temperature: NaN }), /temperature/);
    await assert.rejects(askGrok({ ...options, maxTokens: 0 }), /maxTokens/);
  });

  await check('spend guard blocks caps, resets days and rejects corrupt ledger', async () => {
    resetLedger();
    globalThis.fetch = async () => { throw new Error('Should not request'); };
    process.env.FL_MAX_USD = '0';
    await assert.rejects(askGrok(options), /spend cap/);
    process.env.FL_MAX_USD = '1';
    process.env.FL_MAX_CALLS_PER_DAY = '0';
    assert.match(overBudget(), /daily call cap/);
    process.env.FL_MAX_CALLS_PER_DAY = '1';
    addUsage('grok-4.3', { input_tokens: 10, output_tokens: 5 });
    assert.match(overBudget(), /daily call cap/);
    ledger.day = '2000-01-01';
    assert.equal(overBudget(), null);
    addUsage('grok-4.3', {});
    assert.equal(ledger.callsToday, 1);
    ledger.usd = 'corrupt';
    assert.throws(overBudget, /Invalid/);
  });

  await check('HTTP errors include status and truncate/redact body', async () => {
    resetLedger();
    globalThis.fetch = async () => reply(`Rejected ${fakeKey} ${'x'.repeat(300)}`, 401);
    let error;
    try { await askGrok(options); } catch (caught) { error = caught; }
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes(fakeKey));
    assert.ok(error.message.length <= 214);
  });

  await check('unmetered success exhausts budget and blocks next call', async () => {
    resetLedger();
    let count = 0;
    globalThis.fetch = async () => { count++; return reply({ choices: [{ message: call('done', { summary: 'Finished' }) }] }); };
    await assert.rejects(askGrok(options), /missing or invalid token usage/);
    assert.equal(ledger.usd, 1);
    assert.equal(ledger.calls, 1);
    await assert.rejects(askGrok(options), /Unmetered/);
    assert.equal(count, 1);
  });

  await check('invalid response object fails closed with HTTP status', async () => {
    resetLedger();
    const isolated = await import('./xai.js?invalid-response-test');
    globalThis.fetch = async () => reply('null');
    await assert.rejects(isolated.askGrok(options), /HTTP 200: invalid JSON/);
    assert.equal(ledger.usd, 1);
    assert.match(isolated.overBudget(), /Unmetered/);
  });

  await check('20-second timeout aborts and blocks ambiguous billing', async () => {
    resetLedger();
    const isolated = await import('./xai.js?timeout-test');
    const realSetTimeout = globalThis.setTimeout;
    let requestedDelay;
    globalThis.setTimeout = (callback, ms, ...args) => {
      requestedDelay = ms;
      return realSetTimeout(callback, 0, ...args);
    };
    globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    try {
      await assert.rejects(isolated.askGrok(options), /timed out after 20 seconds/);
      assert.equal(requestedDelay, 20000);
      assert.equal(ledger.usd, 1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  await check('ledger write failure blocks later requests against stale usage', async () => {
    resetLedger();
    const isolated = await import('./xai.js?write-failure-test');
    const testWrite = fs.writeFileSync;
    let count = 0;
    globalThis.fetch = async () => { count++; return reply({ choices: [{ message: call('done', { summary: 'Finished' }) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }); };
    fs.writeFileSync = () => { throw new Error('Read-only ledger'); };
    syncBuiltinESMExports();
    try {
      await assert.rejects(isolated.askGrok(options), /Cannot record xAI usage/);
      assert.equal(ledger.calls, 0);
      await assert.rejects(isolated.askGrok(options), /further requests blocked/);
      assert.equal(count, 1);
    } finally {
      fs.writeFileSync = testWrite;
      syncBuiltinESMExports();
    }
  });
} finally {
  globalThis.fetch = original.fetch;
  fs.readFileSync = original.read;
  fs.writeFileSync = original.write;
  syncBuiltinESMExports();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

await check('questions and show-me requests take the search fast path, screen questions do not', async () => {
  assert.equal(route('show me the weather forecast for San Diego').actions[0].args.url, 'https://www.google.com/search?q=the%20weather%20forecast%20for%20San%20Diego');
  assert.match(route('how tall is the Eiffel Tower?').actions[0].args.url, /^https:\/\/www\.google\.com\/search\?q=how%20tall/);
  assert.equal(route('what is on my screen'), null);
  assert.equal(route('find the blue button on this page'), null);
  assert.equal(route('what is the code for this'), null);
});

await check('a batch of only open_url ends the run with one model call', async () => {
  const f = fixture([call('open_url', { url: 'https://example.com/' })]);
  const result = await f.agent.run('Take a look around the example site for a while');
  assert.equal(result.ok, true);
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(f.events, [['open_url', 'https://example.com/']]);
});

console.log(`${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
