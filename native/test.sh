#!/bin/sh
set -eu
NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$NATIVE_DIR/build.sh"
cat > "$NATIVE_DIR/.build/check-replies.swift" <<'SWIFT'
import Foundation
import CoreFoundation

let names = ["ping", "screen", "pos", "move", "click", "bad command", "malformed JSON",
             "down", "drag move", "up", "right double click", "scroll", "key",
             "bad coordinate", "bad count", "bad modifier", "bad key code", "bad button",
             "non-object", "final ping", "ax_list", "ax_list capped", "bad AX max", "bad AX budget"]
let failures: Set<Int> = [5, 6, 13, 14, 15, 16, 17, 18, 22, 23]
var index = 0
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
}
while let line = readLine() {
    guard index < names.count,
          let reply = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let ok = reply["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(),
          ok.boolValue == !failures.contains(index) else { fail("unexpected reply at index \(index): \(line)") }
    if failures.contains(index) {
        guard let error = reply["error"] as? String, !error.isEmpty else { fail("missing error") }
    }
    if index == 0 || index == 19 {
        guard let trusted = reply["trusted"] as? NSNumber,
              CFGetTypeID(trusted) == CFBooleanGetTypeID() else { fail("missing trusted boolean") }
    }
    if index == 1 {
        guard let width = reply["width"] as? Double, width.isFinite, width >= 0,
              let height = reply["height"] as? Double, height.isFinite, height >= 0 else { fail("invalid screen size") }
    }
    if index == 2 {
        guard let x = reply["x"] as? Double, x.isFinite,
              let y = reply["y"] as? Double, y.isFinite else { fail("invalid cursor position") }
    }
    if index == 20 || index == 21 {
        guard reply["app"] is String, reply["window"] is String,
              let elements = reply["elements"] as? [[String: Any]], elements.count == (index == 20 ? 3 : 1),
              let truncated = reply["truncated"] as? NSNumber, CFGetTypeID(truncated) == CFBooleanGetTypeID(),
              truncated.boolValue == (index == 21),
              let ms = reply["ms"] as? Double, ms.isFinite, ms >= 0 else { fail("invalid AX reply shape") }
        for (offset, element) in elements.enumerated() {
            guard element["id"] as? Int == offset + 1, element["role"] is String, element["name"] is String else {
                fail("invalid AX identity")
            }
            for key in ["x", "y", "w", "h"] {
                guard let value = element[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                      value.doubleValue.isFinite else { fail("invalid AX geometry") }
            }
        }
        guard elements[0]["x"] as? Int == 990, elements[0]["y"] as? Int == 330 else { fail("expected centre coordinates") }
    }
    print("PASS \(names[index])")
    index += 1
}
guard index == names.count else { fail("expected \(names.count) replies, got \(index)") }
print("PASS all \(index) dry-run replies")
SWIFT
swiftc -O -module-cache-path "$NATIVE_DIR/.build/module-cache" \
  "$NATIVE_DIR/.build/check-replies.swift" -o "$NATIVE_DIR/.build/check-replies"
"$NATIVE_DIR/bin/flmouse" --dry > "$NATIVE_DIR/.build/replies.jsonl" <<'JSON'
{"op":"ping"}
{"op":"screen"}
{"op":"pos"}
{"op":"move","x":-100,"y":1000000}
{"op":"click","button":"left","count":1}
{"op":"bogus"}
not JSON
{"op":"down","button":"left"}
{"op":"move","x":40,"y":60}
{"op":"up","button":"left"}
{"op":"click","button":"right","count":2}
{"op":"scroll","dx":10,"dy":-20}
{"op":"key","code":0,"flags":["cmd","shift","alt","ctrl"]}
{"op":"move","x":true,"y":0}
{"op":"click","button":"left","count":3}
{"op":"key","code":0,"flags":["super"]}
{"op":"key","code":65536,"flags":[]}
{"op":"down","button":"right"}
[]
{"op":"ping"}
{"op":"ax_list","max":60,"budget_ms":350}
{"op":"ax_list","max":1}
{"op":"ax_list","max":false}
{"op":"ax_list","budget_ms":0}
JSON
"$NATIVE_DIR/.build/check-replies" < "$NATIVE_DIR/.build/replies.jsonl"
