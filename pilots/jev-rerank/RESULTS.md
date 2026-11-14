# Jev reranking pilot: result

Run Sat Nov 14 2026, about 12:30 PM PT. Rules were committed first (`PREREG.md`, commit ec3059a). Run once. Numbers are in `results.json`.

## Verdict: MISSED. Jev is not added to the word guesser.

| Bar (combined rule) | Needed | Got | |
|---|---|---|---|
| 1. Wrong words at 0.5 noise drop by 2 points | 5.4% to 3.4% or lower | 5.4% to 4.2% (1.2 points) | missed |
| 2. Wrong words at 0.35 noise do not go up | 1.3% or lower | 1.3% | met |
| 3. Median time per call 400 ms or less | 400 ms | 73 ms (90th percentile 101 ms) | met |

313 words at each noise level, 60 sentences.

## What it shows

- **Jev alone is much worse than the decoder:** 10.5% wrong at normal noise and 19.8% at sloppy noise, against 1.3% and 5.4%. It does not see how close each press was to each key, so it throws away the strongest evidence.
- **Combined with the decoder it helps a little:** at sloppy noise it fixed 9 words and broke 5, a net of 4 words out of 313. That is 1.2 points, under the 2-point bar, and too few words to trust.
- **There was little room to begin with:** the right word was already in the decoder's top 4 for 99.4% to 99.7% of words, and the decoder's top pick was already right 94.6% to 98.7% of the time.
- **Speed is not the problem:** 73 ms a call would be fast enough to run on every word.

## Cost

270,000 input tokens, $0.0113 in total. My estimate before the run was under one cent, so it came in slightly over, because each call used about 430 tokens and not the 120 I assumed.

## Limits

Simulated presses, not a real face. One fixed seed. Everyday AAC sentences only.
