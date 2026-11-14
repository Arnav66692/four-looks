import Foundation
import CoreGraphics
import ApplicationServices
import Darwin

enum CommandError: Error {
    case invalid(String)
}

let dryRun = CommandLine.arguments.dropFirst().contains("--dry")
var leftHeld = false

func number(_ object: [String: Any], _ key: String) throws -> Double {
    guard let value = object[key] as? NSNumber,
          CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
        throw CommandError.invalid("\(key) must be a finite number")
    }
    return value.doubleValue
}

func integer(_ object: [String: Any], _ key: String, range: ClosedRange<Double>) throws -> Int64 {
    let value = try number(object, key)
    guard value.rounded(.towardZero) == value, range.contains(value) else {
        throw CommandError.invalid("\(key) must be an integer in \(range)")
    }
    return Int64(value)
}

func button(_ object: [String: Any], leftOnly: Bool = false) throws -> CGMouseButton {
    switch object["button"] as? String {
    case "left": return .left
    case "right" where !leftOnly: return .right
    default: throw CommandError.invalid(leftOnly ? "button must be left" : "button must be left or right")
    }
}

func cursor() throws -> CGPoint {
    guard let event = CGEvent(source: nil) else {
        throw CommandError.invalid("cannot read cursor position")
    }
    return event.location
}

func requirePostingAccess() throws {
    if !dryRun && !AXIsProcessTrusted() { throw CommandError.invalid("accessibility") }
}

func mouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton) throws -> CGEvent {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: point, mouseButton: button) else {
        throw CommandError.invalid("cannot create mouse event")
    }
    return event
}

func handle(_ line: String) throws -> [String: Any] {
    guard let data = line.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let op = object["op"] as? String else {
        throw CommandError.invalid("expected a JSON object with an op string")
    }
    switch op {
    case "ping":
        return ["ok": true, "trusted": AXIsProcessTrusted()]
    case "screen":
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return ["ok": true, "width": bounds.width, "height": bounds.height]
    case "pos":
        let point = try cursor()
        return ["ok": true, "x": point.x, "y": point.y]
    case "move":
        let x = try number(object, "x")
        let y = try number(object, "y")
        let bounds = CGDisplayBounds(CGMainDisplayID())
        try requirePostingAccess()
        if !dryRun {
            guard bounds.width > 0, bounds.height > 0 else {
                throw CommandError.invalid("main display unavailable")
            }
            let point = CGPoint(x: min(max(x, bounds.minX), bounds.maxX - 1),
                                y: min(max(y, bounds.minY), bounds.maxY - 1))
            try mouseEvent(leftHeld ? .leftMouseDragged : .mouseMoved, at: point, button: .left)
                .post(tap: .cghidEventTap)
        }
    case "click":
        let selected = try button(object)
        let count = try integer(object, "count", range: 1...2)
        try requirePostingAccess()
        if !dryRun {
            let point = try cursor()
            let downType: CGEventType = selected == .left ? .leftMouseDown : .rightMouseDown
            let upType: CGEventType = selected == .left ? .leftMouseUp : .rightMouseUp
            // Construct all events before posting so allocation failure cannot leave a button down.
            var events: [CGEvent] = []
            for click in 1...count {
                for type in [downType, upType] {
                    let event = try mouseEvent(type, at: point, button: selected)
                    event.setIntegerValueField(.mouseEventClickState, value: click)
                    events.append(event)
                }
            }
            for event in events { event.post(tap: .cghidEventTap) }
        }
        if selected == .left { leftHeld = false }
    case "down", "up":
        _ = try button(object, leftOnly: true)
        try requirePostingAccess()
        if !dryRun {
            let event = try mouseEvent(op == "down" ? .leftMouseDown : .leftMouseUp,
                                       at: cursor(), button: .left)
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.post(tap: .cghidEventTap)
        }
        leftHeld = op == "down"
    case "scroll":
        let dx = try integer(object, "dx", range: Double(Int32.min)...Double(Int32.max))
        let dy = try integer(object, "dy", range: Double(Int32.min)...Double(Int32.max))
        try requirePostingAccess()
        if !dryRun {
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                      wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else {
                throw CommandError.invalid("cannot create scroll event")
            }
            event.post(tap: .cghidEventTap)
        }
    case "key":
        let code = try integer(object, "code", range: 0...65535)
        guard let names = object["flags"] as? [String] else {
            throw CommandError.invalid("flags must be an array of modifier names")
        }
        let modifiers: [String: CGEventFlags] = ["cmd": .maskCommand, "shift": .maskShift,
                                                 "alt": .maskAlternate, "ctrl": .maskControl]
        var flags: CGEventFlags = []
        for name in names {
            guard let flag = modifiers[name] else { throw CommandError.invalid("unknown modifier: \(name)") }
            flags.formUnion(flag)
        }
        try requirePostingAccess()
        if !dryRun {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: false) else {
                throw CommandError.invalid("cannot create keyboard event")
            }
            down.flags = flags
            up.flags = flags
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    default:
        throw CommandError.invalid("unknown op: \(op)")
    }
    return ["ok": true]
}

while let line = readLine() {
    autoreleasepool {
        let reply: [String: Any]
        do {
            reply = try handle(line)
        } catch CommandError.invalid(let message) {
            reply = ["ok": false, "error": message]
        } catch {
            reply = ["ok": false, "error": "invalid JSON"]
        }
        // Every reply contains only JSON-compatible values.
        let data = try! JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
        fflush(stdout)
    }
}
