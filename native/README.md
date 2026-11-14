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
