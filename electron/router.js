// Deliberately conservative: an uncertain command belongs on the confirmed model path.
const SITES = {
  gmail: 'mail.google.com', google: 'www.google.com', youtube: 'www.youtube.com',
  'google calendar': 'calendar.google.com', 'google drive': 'drive.google.com',
  'google docs': 'docs.google.com', 'google maps': 'maps.google.com', github: 'github.com',
  devpost: 'devpost.com', chatgpt: 'chatgpt.com', grok: 'grok.com', x: 'x.com', twitter: 'x.com',
  reddit: 'www.reddit.com', wikipedia: 'www.wikipedia.org', amazon: 'www.amazon.com',
  netflix: 'www.netflix.com', spotify: 'open.spotify.com', linkedin: 'www.linkedin.com',
  slack: 'app.slack.com', notion: 'www.notion.so', canvas: 'canvas.instructure.com',
};
const APPS = {
  chrome: 'Google Chrome', 'google chrome': 'Google Chrome', safari: 'Safari', notes: 'Notes',
  messages: 'Messages', mail: 'Mail', finder: 'Finder', calendar: 'Calendar', terminal: 'Terminal',
  spotify: 'Spotify', slack: 'Slack', settings: 'System Settings', 'system settings': 'System Settings',
  textedit: 'TextEdit', music: 'Music', photos: 'Photos', maps: 'Maps', cursor: 'Cursor',
  'vs code': 'Visual Studio Code', 'visual studio code': 'Visual Studio Code', discord: 'Discord', zoom: 'zoom.us',
};
const BLOCKED = /\b(send|submit|post|buy|pay|order|delete|remove|passwords?|cards?|codes?)\b/i;
const ON_SCREEN = /\b(this|that|these|those|here|it|its|screen|page|tab|window|click|button|link|file|folder|app|document|my|mine|open)\b/i;
const QUESTION = /^(?:what|who|when|where|which|why|how|weather|news|define|meaning of|translate|convert)\b.{3,}$/i;
const action = (name, args, summary) => ({ actions: [{ name, args }], summary });
const urlAction = (url, summary = 'Opened the requested page.') => action('open_url', { url }, summary);
const keyAction = (name) => action('key', { name }, 'Keyboard shortcut completed.');
const polite = (text) => text.trim().replace(/^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+)+/i, '')
  .replace(/(?:,?\s+please)[.!?]*$/i, '').trim();

function single(raw) {
  const text = polite(raw);
  const command = text.replace(/[.!?,;]+$/, '').trim().replace(/\s+/g, ' ');
  let match;
  if ((match = command.match(/^(?:open|go to|launch|pull up)\s+(.+)$/i))) {
    let target = match[1].toLowerCase().replace(/^the\s+/, '');
    const app = /^app\s+|\s+app$/.test(target);
    target = target.replace(/^app\s+|\s+app$/g, '');
    if (!app && Object.hasOwn(SITES, target)) return urlAction(`https://${SITES[target]}`);
    if (Object.hasOwn(APPS, target)) return action('open_app', { name: APPS[target] }, `Opened ${APPS[target]}.`);
    // Permit explicitly spoken URLs too, without treating arbitrary prose as a host.
    return directUrl(match[1]);
  }
  if ((match = text.match(/^(?:(?:email|mail)\s+(?:to\s+)?|compose an email to\s+)(.+)$/i))) {
    const delimiter = /\s+(?:that says|saying|body)\s+|\s*:\s*/i.exec(match[1]);
    const header = (delimiter ? match[1].slice(0, delimiter.index) : match[1]).trim();
    const body = delimiter ? match[1].slice(delimiter.index + delimiter[0].length) : '';
    const subject = header.match(/\s+subject\s+(.+)$/i);
    const to = (subject ? header.slice(0, subject.index) : header).trim();
    if (!to || /[\r\n<>]/.test(to)) return null;
    const encode = encodeURIComponent;
    return urlAction(`https://mail.google.com/mail/?view=cm&fs=1&to=${encode(to)}&su=${encode(subject?.[1] ?? '')}&body=${encode(body)}`,
      'The email draft is open. Nothing was sent.');
  }
  if ((match = command.match(/^(?:search youtube for|youtube)\s+(.+)$/i)))
    return urlAction(`https://www.youtube.com/results?search_query=${encodeURIComponent(match[1])}`);
  if ((match = command.match(/^wikipedia\s+(.+)$/i)))
    return urlAction(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(match[1])}`);
  if ((match = command.match(/^(directions to|map of)\s+(.+)$/i)))
    return urlAction(match[1].toLowerCase() === 'directions to'
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(match[2])}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(match[2])}`);
  if ((match = command.match(/^(?:search(?: for)?|google|look up)\s+(.+)$/i)))
    return urlAction(`https://www.google.com/search?q=${encodeURIComponent(match[1])}`);
  const keys = {
    'new tab': 'cmd+t', 'switch app': 'cmd+tab', 'switch window': 'cmd+tab',
    'go back': 'cmd+[', 'go forward': 'cmd+]', refresh: 'cmd+r', reload: 'cmd+r',
    'select all': 'cmd+a', copy: 'cmd+c', paste: 'cmd+v', undo: 'cmd+z', spotlight: 'cmd+space',
  };
  if (Object.hasOwn(keys, command.toLowerCase())) return keyAction(keys[command.toLowerCase()]);
  if ((match = command.match(/^scroll (down|up)$/i)))
    return action('scroll', { dy: match[1].toLowerCase() === 'down' ? -500 : 500 }, 'Scrolled the page.');
  if ((match = text.match(/^type\s+([\s\S]+)$/i))) return action('type', { text: match[1] }, 'Typed the requested text.');
  // A plain question or "show me" request that says nothing about what is on the screen is a web search.
  if (!ON_SCREEN.test(command)) {
    if ((match = command.match(/^(?:show me|find me|find)\s+(.+)$/i)))
      return urlAction(`https://www.google.com/search?q=${encodeURIComponent(match[1])}`, 'Searched the web for that.');
    if (QUESTION.test(command))
      return urlAction(`https://www.google.com/search?q=${encodeURIComponent(command)}`, 'Searched the web for that.');
  }
  return directUrl(command);
}

function directUrl(text) {
  if (/\s/.test(text) || !/^(?:https?:\/\/|(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?:[/:?#]|$))/i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return urlAction(url.href);
  } catch { return null; }
}

export function route(goal) {
  if (typeof goal !== 'string' || !goal.trim() || BLOCKED.test(goal)) return null;
  const parts = goal.split(/\s+and then\s+|,\s*then\s+|\s+then\s+/i);
  const routed = parts.map(single);
  if (routed.some((part) => !part)) return null;
  return { actions: routed.flatMap((part) => part.actions), summary: routed.map((part) => part.summary).join(' ') };
}
