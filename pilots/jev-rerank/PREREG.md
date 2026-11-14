# Jev reranking pilot: rules set before the run

Written Sat Nov 14 2026, about 12:30 PM PT, before any Jev call for this pilot.

## Question

When a word ends, the keyboard decoder ranks candidate words. Does asking Jev to pick among the
decoder's top 4, using the sentence so far, give fewer wrong words than the decoder's own top pick?

## Setup

- Data: the first 60 sentences of the public AAC dev set (`sent_dev_aac.txt`), every word, in order.
- Typing: simulated presses on a QWERTY grid with Gaussian aim noise, the same model as `tools/kb-smoke.mjs`.
  Two noise levels, fixed seed 7: 0.35 key widths (normal) and 0.5 key widths (sloppy).
- Context given to Jev: the true words so far in the sentence (the user confirms words as they go).
- Candidates: `KeyTyper.ranked(4)`, shuffled with a fixed seed so position carries no information.
- Model: `jev-latest`, one Choice question per word, called one at a time so latency is per word.

## Two rules, both reported

- **Jev alone:** the candidate Jev gives the highest probability.
- **Combined (the one we would ship):** highest of Jev probability times the decoder's own probability
  (softmax of the decoder's log10 scores). No weight to tune.

## Pass bar, all three must hold for the combined rule

1. At 0.5 noise, wrong words drop by at least 2 points against the decoder alone.
2. At 0.35 noise, wrong words do not go up.
3. Median time per call is 400 ms or less, so it can run on every word.

If it misses, Jev is not added to the word guesser. No reruns with changed prompts to rescue it.

## Cost

About 600 calls of roughly 120 input tokens at $0.042 per million tokens: under one cent.
