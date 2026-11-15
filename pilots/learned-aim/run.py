"""Pilot for PREREG.md: does a correction learned from his own presses put the first settle point on the key?"""
import glob
import json
import statistics as st

import numpy as np

KEYS = [["⌫",12,183,167,63],["q",184,183,113,63],["j",302,183,113,63],["v",420,183,113,63],["p",539,183,113,63],["b",657,183,113,63],["k",775,183,113,63],["x",893,183,113,63],["z",1012,183,113,63],["'",1130,183,113,63],["send",1248,183,210,63],["r",12,250,140,63],["s",157,250,140,63],["i",302,250,140,63],["a",447,250,140,63],["e",592,250,140,63],["t",737,250,140,63],["o",883,250,140,63],["n",1028,250,140,63],["h",1173,250,140,63],["d",1318,250,140,63],["shift",12,318,164,63],["g",181,318,112,63],["w",298,318,112,63],["u",414,318,112,63],["l",531,318,112,63],["c",647,318,112,63],["m",764,318,112,63],["f",880,318,112,63],["y",997,318,112,63],[",",1113,318,112,63],[".",1230,318,112,63],["?",1346,318,112,63]]
RECT = {k: (x, y, w, h) for k, x, y, w, h in KEYS}
INPUT = ("letter", "space", "backspace", "undo", "symbol", "pick", "ghost", "send", "speak")

rows = []   # (session, key, settle_x, settle_y, travel_s)
for f in sorted(glob.glob("data/sessions/*.jsonl")):
    ev = [json.loads(l) for l in open(f) if l.strip()]
    p = [e for e in ev if e["type"] == "p" and e["x"] >= 0]
    if len(p) < 50 or max(e["x"] for e in p) < 1000: continue          # simulated face runs in a narrow pane
    if abs(max(e["y"] for e in p) - 486) > 6: continue                 # a different window size
    inp = [e for e in ev if e["type"] in INPUT]
    for i in range(1, len(inp)):
        e = inp[i]
        if e["type"] != "letter" or e.get("key") not in RECT: continue
        seg = [q for q in p if inp[i - 1]["t"] + 300 <= q["t"] <= e["t"]]
        for j in range(2, len(seg)):
            a, b, c = seg[j - 2], seg[j - 1], seg[j]
            still = ((b["x"] - a["x"]) ** 2 + (b["y"] - a["y"]) ** 2) ** 0.5 < 25 and ((c["x"] - b["x"]) ** 2 + (c["y"] - b["y"]) ** 2) ** 0.5 < 25
            if still and c["y"] >= 150:
                rows.append((f[-29:-6], e["key"], c["x"], c["y"], (e["t"] - c["t"]) / 1000))
                break

sessions = sorted(set(r[0] for r in rows))
print(f"real sessions used: {len(sessions)}, letter presses with a first settle point: {len(rows)}")
for s in sessions: print("  ", s, sum(1 for r in rows if r[0] == s))

def centre(k): x, y, w, h = RECT[k]; return (x + w / 2, y + h / 2)
def inside(k, x, y): kx, ky, w, h = RECT[k]; return kx <= x <= kx + w and ky <= y <= ky + h

before_hit = before_d = after_hit = after_d = n = 0
per = []
for held in sessions:
    train = [r for r in rows if r[0] != held]; test = [r for r in rows if r[0] == held]
    if len(train) < 12 or not test: continue
    X = np.array([[r[2], r[3], 1] for r in train]); T = np.array([centre(r[1]) for r in train])
    A, *_ = np.linalg.lstsq(X, T, rcond=None)
    bh = bd = ah = ad = 0
    for r in test:
        cx, cy = centre(r[1])
        bh += inside(r[1], r[2], r[3]); bd += ((r[2] - cx) ** 2 + (r[3] - cy) ** 2) ** 0.5
        x2, y2 = np.array([r[2], r[3], 1]) @ A
        ah += inside(r[1], x2, y2); ad += ((x2 - cx) ** 2 + (y2 - cy) ** 2) ** 0.5
    per.append((held, len(test), bh, ah, bd / len(test), ad / len(test)))
    before_hit += bh; after_hit += ah; before_d += bd; after_d += ad; n += len(test)

print("\nheld-out session, presses, on key before, on key after, mean distance before px, after px")
for row in per: print("  ", row[0], row[1], row[2], row[3], round(row[4]), round(row[5]))
if n:
    bh, ah = 100 * before_hit / n, 100 * after_hit / n
    bd, ad = before_d / n, after_d / n
    print(f"\npooled held-out presses: {n}")
    print(f"first settle point on the pressed key: {bh:.0f}% before, {ah:.0f}% after  (change {ah - bh:+.0f} points, bar +10)")
    print(f"mean distance to the key centre: {bd:.0f} px before, {ad:.0f} px after  (change {100 * (ad - bd) / bd:+.0f}%, bar -20%)")
    ok = (ah - bh) >= 10 and (bd - ad) / bd >= 0.20
    print("RESULT:", "PASS" if ok else "FAIL")
    X = np.array([[r[2], r[3], 1] for r in rows]); T = np.array([centre(r[1]) for r in rows])
    off = T - X[:, :2]
    print(f"raw offset (key centre minus settle point), all presses: x mean {off[:,0].mean():+.0f} px sd {off[:,0].std():.0f}, y mean {off[:,1].mean():+.0f} px sd {off[:,1].std():.0f}")
    print(f"time from first settle to the press: median {st.median(r[4] for r in rows):.1f} s")
