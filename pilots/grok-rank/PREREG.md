# Pilot: does Grok rank spelling candidates better than the app's own order?

Written Nov 15, 2026, 1:50 AM PT, before any call was made.

## The idea (In A Park, email of Nov 15, 1:44 AM PT)

Send the sentence so far and the dictionary candidates to Grok. Grok ranks them by how well each fits
the sentence. The top word goes in the centre (the bold guess). If the call fails or the answer is not
exactly the same words, keep the original order.

## What the app does today

The bold guess for a misspelled word is the closest dictionary word, ranked by how likely it is after
the ONE word before it, less a cost per spelling edit. No model call.

## Test

31 sentences whose last word is misspelled. 11 are In A's own words with the contexts in
`tools/spell-check.mjs`. 20 are new, written before the run, listed in `tools/rank-pilot.mjs`.
For each, the candidates are the app's own guesses plus up to six spelling fixes (at most eight words).
One Grok call per sentence, model `grok-4.20-0309-non-reasoning`, temperature 0.

## Pass bar, all three

1. Grok's first choice is the intended word in at least 3 more sentences than the app's own first choice.
2. On In A's 11 words Grok is not worse than the app's own order.
3. Median answer time is 900 ms or less.

If any one fails, the feature is not built. Results that hurt the idea are reported as they are.

## Cost

About 31 calls of roughly 150 tokens each. Estimated at the fallback price in `server.js`
(2 dollars per million input tokens, 6 per million output): about 1 to 2 cents. The spend guard
stood at about 0.33 of its 1 dollar cap before the run.

## Run 1 result (Nov 15, 2026, 1:51 AM PT): FAIL

First choice right: app 26 of 31, Grok 26 of 31. On In A's eleven: app 10, Grok 9. Median 585 ms.
Bars 1 and 2 failed, bar 3 passed. Rows are in `results-run1.json`.

Grok got four right that the app got wrong (door, time, watch, book). It got four wrong that the app
got right, and in all four it chose the misspelled letters themselves (rst, hangry, windw, fod).

## Amendment, written 1:51 AM PT, before run 2

The candidate list in run 1 included the letters as typed, which are not a word. In A's design ranks
dictionary candidates only, so that was an error in my setup, not in her idea. Run 2 changes one
thing: letters that are not a dictionary word are left out of the list sent to Grok. Same 31 cases,
same prompt, same model, same three bars. Run 2 is the one that decides. Both runs are reported.

## Run 2 result (Nov 15, 2026, 1:53 AM PT): PASS on the bar as written

First choice right: app 26 of 31, Grok 30 of 31. On In A's eleven: app 10, Grok 11. Median 425 ms,
slowest 936 ms, no call fell back. Rows are in `results.json`. The two runs cost about 4 cents
together by the app's own estimate (0.329 to 0.371 dollars on the spend guard).

## What the pass was really worth (written 2:12 AM PT, after run 2)

Three of the app's five misses in run 2 (door, book, watch) had one cause, and it was a fault in the
app, not a limit of its method. The word list holds junk tokens (dor, bok, wach), so the app treated
those letters as real words and did not lead with a spelling fix. The other two misses were "what tme"
and "i am thirty". That is fixed now: a listed word rarer than
10^-4.6 counts as a likely misspelling (`RARE_WORD` in `src/keytyper.js`).

With that fix and no Grok, the app's first choice is right in 29 of 31, and 11 of 11 on In A's words
(`LOCAL_ONLY=1 node tools/rank-pilot.mjs`, no calls, saved in `results-app-alone.json`). Grok's 30 of 31 is one sentence better
("what tme": the app says "the", Grok says "time"). Against the fixed app the gain is 1, which is
under the bar of 3.

Honest reading: the larger win from this pilot was finding the junk-token fault. Grok ranking adds a
little on top. It is built, off by default, and costs nothing while off. Whether to keep it is
Arnav's call.
