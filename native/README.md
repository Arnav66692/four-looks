# Four Looks native mouse helper
Swift CLI for real macOS cursor, mouse, scroll, and keyboard events; no dependencies.
Build: `native/build.sh` (requires Apple's Swift compiler).
Run: `native/bin/flmouse`; send one JSON object per stdin line; one flushed JSON reply per line.
Use `--dry` to validate without posting events (works without Accessibility permission).
Test: `native/test.sh` builds and checks only dry-run commands.
Commands (`op` field):
- `ping`: returns `ok` and Accessibility `trusted`.
- `screen`: main-display `width`, `height` in points; `pos`: global `x`, `y`, origin top-left.
- `move`: numeric `x`, `y`, clamped to the main display; drags while left is down.
- `click`: `button` = `left`/`right`, `count` = 1/2.
- `down` / `up`: `button` = `left`.
- `scroll`: signed 32-bit integer pixel `dx`, `dy`.
- `key`: integer virtual key `code` (0–65535), `flags` array: `cmd`, `shift`, `alt`, `ctrl`.
Enable Accessibility for the launching app in System Settings → Privacy & Security; untrusted posting returns `{"ok":false,"error":"accessibility"}`. Invalid commands return errors and processing continues.

`ax_list` is read-only: `{"op":"ax_list","max":60,"budget_ms":350}` (both limits optional).
Requires Accessibility permission for whatever app launched the helper; otherwise returns `{"ok":false,"error":"not trusted"}`.
Returns `{"ok":true,"app":"…","window":"…","elements":[{"id":1,"role":"AXButton","name":"Compose","x":990,"y":330,"w":180,"h":60}],"truncated":false,"ms":12.3}`.
Elements have 1-based IDs sorted top to bottom, then left to right; x/y are centres in global top-left display points.
Lists enabled, named controls and text inputs; secure input values are never read or returned.
Walks the focused window (fallback: main window, then all windows); `truncated` marks a limit/deadline stop.
`max` accepts 1–10000 and `budget_ms` accepts 1–60000; AX messaging timeouts bound slow app requests.
`--dry` returns three fixed fake controls (subject to `max`); Node: `mouse.axList({ max: 60, budgetMs: 350 })`.
