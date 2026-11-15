# Result: FAIL (Nov 14, 2026, 4:17 PM PT)

Run with `python3 pilots/learned-aim/run.py`. 5 real sessions, 57 letter presses, leave one session out.

| Measure on held-out presses | Before | After the learned correction | Bar |
|---|---|---|---|
| First settle point on the pressed key | 14% | 4% | +10 points |
| Mean distance to the key centre | 307 px | 262 px (-15%) | -20% |

Both bars missed. The correction made the hit rate worse.

## Why
There is no consistent offset to learn. Key centre minus first settle point, all presses:
x mean -10 px with a spread of 393 px, y mean -27 px with a spread of 67 px.
A 393 px spread means the first place his cursor pauses after a press is usually not near the key
he presses next. The median time from that first pause to the press is 3.9 s.

## What it does say
Most of the time per letter is not aiming error. He pauses somewhere else first, then goes to the
key. That fits hunting for the letter on a layout he does not know by heart (the head layout),
or reading the guesses. It is a reading of the traces, not a proven cause.

## What to try instead (not built)
- QWERTY, which he knows, to cut the hunt. He asked for it and it is on the Key layout tile.
- A real learned-aim model needs presses with a known target: a guided run that shows the letter to
  press. 57 free-typing presses with a noisy label are not that. A 3 minute guided run would give about
  100 clean ones.
