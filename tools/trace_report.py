"""Report on a normal typing session from its saved cursor trace.
Usage: python3 tools/trace_report.py data/sessions/<file>.jsonl
For each letter press it splits the time into travel (until the cursor first lands on that key)
and settle (from landing to the press), and counts slips off the key and selection changes."""
import collections
import json
import statistics as st
import sys

ev = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
count = collections.Counter(e["type"] for e in ev)
print({k: v for k, v in count.items()})
for e in ev:
    if e["type"] in ("calibrate", "cue-calibrate", "send", "speak", "mode", "setting", "layout", "click", "switch-app", "ghost-phrase", "ghost-next", "recenter"):
        print(" ", e["type"], {k: v for k, v in e.items() if k not in ("t", "type")})

INPUTS = ("letter", "space", "backspace", "undo", "symbol", "pick", "ghost", "ghost-phrase")
inp = [e for e in ev if e["type"] in INPUTS]
trace = [e for e in ev if e["type"] == "p"]
if inp:
    print("inputs:", " ".join((e.get("key") or e.get("word") or " ".join(e.get("words", [])) or e["type"]) for e in inp))
    span = (inp[-1]["t"] - inp[0]["t"]) / 1000
    letters = sum(1 for e in inp if e["type"] == "letter")
    deletes = sum(1 for e in inp if e["type"] in ("backspace", "undo"))
    print(f"typing span {span:.0f} s, {len(inp)} inputs, {letters} letters, {deletes} deletes, "
          f"{sum(1 for e in inp if e['type'].startswith('ghost'))} nods, {sum(1 for e in inp if e['type'] == 'pick')} picks")

if trace and inp:
    rows = []
    prev = inp[0]["t"]
    for e in inp[1:]:
        if e["type"] != "letter":
            prev = e["t"]
            continue
        seg = [p for p in trace if prev < p["t"] <= e["t"]]
        if len(seg) < 3:
            prev = e["t"]
            continue
        on = [p["on"] == e["key"] for p in seg]
        first = next((i for i, v in enumerate(on) if v), None)
        if first is None:
            prev = e["t"]
            continue
        slips = sum(1 for i in range(first + 1, len(on)) if on[i - 1] and not on[i])
        flips = sum(1 for i in range(1, len(seg)) if seg[i]["on"] != seg[i - 1]["on"])
        last = [p for p in seg if e["t"] - p["t"] < 400]
        wobble = (st.pstdev([p["x"] for p in last]) ** 2 + st.pstdev([p["y"] for p in last]) ** 2) ** 0.5 if len(last) > 1 else 0
        rows.append((e["key"], (seg[first]["t"] - prev) / 1000, (e["t"] - seg[first]["t"]) / 1000, slips, flips, wobble))
        prev = e["t"]
    if rows:
        print(f"letter presses analysed: {len(rows)}")
        print(f"  travel to the key              median {st.median(r[1] for r in rows):.1f} s")
        print(f"  from landing on it to pressing median {st.median(r[2] for r in rows):.1f} s")
        print(f"  slipped off the key before pressing: {sum(1 for r in rows if r[3] > 0)} of {len(rows)}")
        print(f"  selection changes per press    median {st.median(r[4] for r in rows)}")
        print(f"  wobble in the last 0.4 s       median {st.median(r[5] for r in rows):.1f} px")
        for r in rows[:16]:
            print(f"    {r[0]}: travel {r[1]:.1f} s, settle {r[2]:.1f} s, slips {r[3]}, selection changes {r[4]}, wobble {r[5]:.0f} px")
    gaps = [trace[i]["t"] - trace[i - 1]["t"] for i in range(1, len(trace))]
    print(f"trace: {len(trace)} samples, median gap {st.median(gaps):.0f} ms, gaps over 400 ms: {sum(1 for g in gaps if g > 400)}")
    if len(trace) > 20:
        xs = [p["x"] for p in trace if p["x"] >= 0]
        ys = [p["y"] for p in trace if p["y"] >= 0]
        print(f"cursor range: x {min(xs)} to {max(xs)}, y {min(ys)} to {max(ys)}")
