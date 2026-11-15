# Pilot: learn where his cursor settles, instead of tracking only

Written Nov 14, 2026, 4:15 PM PT, before running the analysis.

## Idea (his)
Use data on where the head actually goes when he selects keys to cut drag and overshoot,
instead of trusting the tracker alone.

## Data
His own real sessions from today with a cursor trace (10 samples a second) and letter presses,
head layout, 1470 x 486 window. Simulated-face sessions are excluded (window under 1000 px wide).
The pressed key is taken as the key he meant. That is noisy: some presses were wrong and undone.

## Question
After travelling to a key, his cursor first settles somewhere. Is that first settle point off the
key in a consistent way that a correction learned from other presses can remove?

## Method
- First settle point: the first sample, at least 300 ms after the previous input, where the cursor
  moved under 25 px in each of two consecutive 100 ms steps and is in the key area.
- Correction: an affine map (6 numbers) from first settle point to the centre of the key he pressed,
  fitted by least squares.
- Test: leave one session out. Fit on the other sessions, score on the held-out one, pool the scores.

## Pass bar (both must hold on held-out presses)
1. The share of first settle points that land inside the pressed key rises by at least 10 points.
2. The mean distance from first settle point to the key centre falls by at least 20%.

## If it fails
Not built today. Report the numbers. The tracking-only cursor stays.
