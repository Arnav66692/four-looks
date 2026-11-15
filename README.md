# Four Looks

Type and control a computer with your head. A laptop camera is the only hardware.

Point your nose at a key and hold still to press it. A word guesser fixes near misses when the word ends. On a Mac it also types into whatever app is in front, moves the real cursor, and can hand a typed sentence to Grok to carry out.

Built at SanD Hacks, Nov 14 to 15, 2026.

## Try it

Pick one. Both need [Node](https://nodejs.org) 20 or newer, a webcam, and an internet connection.

### In a browser, on any computer

About one minute. No `npm install`.

```bash
git clone https://github.com/Arnav66692/four-looks.git
cd four-looks
node tools/setup.mjs --web
node server.js
```

Open http://localhost:5173 in Chrome or Edge and allow the camera.

You get the keyboard, the word guesser, the three key layouts and the speak key. Typing into other apps, the head mouse and Grok control need the Mac app.

### The Mac app

```bash
git clone https://github.com/Arnav66692/four-looks.git
cd four-looks
npm install
npm run setup
npm run app
```

Start it from the Terminal app. The keyboard docks along the bottom of the screen and never takes focus, so what you type goes to the app in front.

macOS asks for permissions for the app that launched it, which is Terminal.

| Permission | Needed for | Where |
|---|---|---|
| Camera | Everything | Asked on first start |
| Accessibility | Typing into other apps, moving the cursor | System Settings, Privacy and Security, Accessibility |
| Screen Recording | Only when Grok has to look at the screen | System Settings, Privacy and Security, Screen Recording |

The head mouse needs the Swift compiler. If setup says it is missing, run `xcode-select --install` and run `npm run setup` again. Typing works without it.

Quit with the X in the corner, or Control Option Q.

### What setup does

`node tools/setup.mjs` uses only what ships with Node, changes nothing outside this folder, and is safe to run again.

1. Checks the Node version.
2. Downloads a public word model (25 MB), checks it against a known checksum, and builds `public/lm.json` (31 MB) from it.
3. Creates an empty `.env` from `.env.example`.
4. On a Mac, builds the small helper that moves the cursor (`native/bin/flmouse`).

The flags are optional. `--web` skips the Mac helper. `--eval` also fetches the public test sentences used by `tools/eval.mjs`. `--force` rebuilds the word model.

## First run

1. Sit so your whole face is in the picture. A dot moves around the keyboard. Point your nose at it each time. This takes about ten seconds and fits the cursor to how you move.
2. The app then learns your press move, a smile by default. If it cannot see the move clearly it switches to hold to press.
3. Point at a key. Smile to press it, or hold still on it if hold to press is on.
4. Open the dots key (bottom row) for settings and the Help tile.

## Gestures

| Do this | It does |
|---|---|
| Point your nose | Moves the cursor |
| Smile, or hold still on a key | Presses the key |
| Nod | Takes the grey word. Nod again to take the phrase |
| One quick head shake | Shows the next guess. Right after an autocorrect, it puts your own letters back |
| Close your eyes for 1 second | Puts the cursor back in the middle |
| Close your eyes for 3 seconds | Calibrates again |
| Press the eye icon beside the status line, or the Grok tile in the dots menu | Wakes Grok. The Help tile shows the hands-free way to wake it in your version |

In mouse mode (the mouse key) your head moves the real cursor, a quick opening of the mouth clicks, and two head shakes the same way switch apps. The keyboard comes back by itself when you click into a text box.

## Settings worth knowing

All in the dots menu.

- **Key layout.** Head (the most used letters in the middle row), boxes (eight big keys in phone pad order), or qwerty.
- **Hold to press** and **Hold time.** Press by holding still, for 1.0, 0.8 or 0.6 seconds.
- **Press with.** Smile, open mouth, pucker, raised brows or a firm blink.
- **Head reach.** How far the cursor moves for the same head turn.
- **Theme**, **Camera view**, **Admin view** (shows what the tracker sees).
- **Calibrate** and **Tune to me.** Refit the cursor to you.

## Grok (optional, Mac app)

Without a key the keyboard, the head mouse and the instant commands all work. Instant commands need no model. Some examples are `open gmail`, `search for pizza near me`, `youtube lofi beats`, `new tab`, `help`, `calibrate`, `mouse mode` and `qwerty`.

For the fix key and for tasks that need thinking, put an xAI key in `.env`.

```bash
XAI_API_KEY=your-key-here
```

Then wake Grok, type what you want, and press `do it`.

- **Spending is capped.** The app keeps its own count in `.usage.json` and stops at an estimated 1 dollar and 300 calls a day. Change the cap with `FL_MAX_USD` and `FL_MAX_CALLS_PER_DAY`.
- **It asks first.** Anything that sends, buys, deletes or closes unsaved work waits for a nod. It will not type passwords, card numbers or one-time codes. It stops if a system permission, password or settings window is in front.
- **What goes to xAI.** The sentence you typed, the names of the buttons and fields in the app in front, and a screenshot only when it has to look. Nothing is sent until you press `do it` or `fix`.

## Privacy

The camera picture never leaves your computer. Face tracking runs inside the page.

The app saves a log of each session in `data/sessions` on your own disk. It holds the cursor path, the keys pressed and the text you sent. It is there so the cursor can be tuned from real use. Delete the folder to clear it.

## Check your install

No camera needed.

```bash
npm run check
```

It runs the offline checks for the Grok agent and types a list of strange words (names, slang, web addresses) through the word guesser. It should end with `0 failed` and every word typed exactly.

To watch the keyboard work without a face, open http://localhost:5173/?sim=1 for a simulated one. The full simulation suite takes about ten minutes. Open http://localhost:5173/?sim=1&app=1&noise=0.004&spike=0.04&lag=120, then in the browser console run

```js
(await import("/hardsim.js")).run()
```

and read `window.__hard` when it finishes.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Starting the camera" and nothing else | The app that launched it has no camera access. Start the Mac app from Terminal. In a browser, allow the camera for localhost |
| Nothing appears in the other app | Turn on Accessibility for Terminal, then start the app again |
| `four looks is already running` | Another copy is open. Quit it with Control Option Q |
| The port is taken | `PORT=5180 node server.js` |
| `npm run app` says Electron is not installed | `node node_modules/electron/install.js` |
| Setup says the word model does not match | Delete `data/raw` and run setup again |
| Mouse mode does nothing | `xcode-select --install`, then `npm run setup` |
| The cursor drifts off | Close your eyes for one second to recentre, three to calibrate again |

## What works today, and what does not

As of Nov 14, 2026.

- **Typing into another app works.** It has typed into a Gmail draft on the Mac it was built on.
- **It is slow so far.** A first-day user measured about 2 to 3 words a minute. Taking the suggested words is faster than spelling.
- **The word guesser** gets 97.5% of words right when key presses are scattered by 0.35 of a key width (1,048 words, `node tools/kb-smoke.mjs 0.35`, needs `--eval` data).
- **Grok tasks ran end to end on one Mac.** Opening an app took 0.2 seconds and typing into a document took 3.0 seconds.
- **Clicks that Grok places from a screenshot are rough.** It prefers links, shortcuts and buttons it can find by name.
- **Not tested.** The desktop app on Windows or Linux (use the browser there), Intel Macs, faces other than the builder's, glasses, low light.
- **Not built.** A cloned voice for the speak key.

## How it is put together

| Folder | What is in it |
|---|---|
| `public/` | The keyboard page, with face tracking, the head pointer, gestures, layouts and the simulated face |
| `src/` | The word guesser |
| `electron/` | The Mac app shell and the Grok agent |
| `native/` | The Swift helper that moves the cursor and reads button names |
| `tools/` | Setup, evaluation and session analysis |
| `pilots/` | Small experiments with their pass bars and results |

Face tracking is MediaPipe Face Landmarker, loaded from jsdelivr and Google storage when the page opens. That is why an internet connection is needed.

## Credits

The word model and test sentences are the public AAC corpus by Vertanen and Kristensson (EMNLP 2011), at [aactext.org/imagine](https://www.aactext.org/imagine/).

Built with AI coding help from Claude Code and Codex.
