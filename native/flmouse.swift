import Foundation
import AppKit
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

// AX geometry already uses global display points with a top-left origin.
func accessibilityList(maximum: Int, budgetMS: Int) -> [String: Any] {
    let started = ProcessInfo.processInfo.systemUptime
    let deadline = started + Double(budgetMS) / 1000
    if dryRun {
        let fake: [[String: Any]] = [
            ["id": 1, "role": "AXButton", "name": "Compose", "x": 990, "y": 330, "w": 180, "h": 60],
            ["id": 2, "role": "AXTextField", "name": "Search", "x": 400, "y": 400, "w": 200, "h": 30],
            ["id": 3, "role": "AXSecureTextField", "name": "Password", "x": 400, "y": 450, "w": 200, "h": 30]
        ]
        return ["ok": true, "app": "Dry App", "window": "Dry Window",
                "elements": Array(fake.prefix(maximum)), "truncated": maximum < fake.count, "ms": 0]
    }
    guard AXIsProcessTrusted() else { return ["ok": false, "error": "not trusted"] }
    var expired: Bool { ProcessInfo.processInfo.systemUptime >= deadline }
    func timeout(_ element: AXUIElement) -> Bool {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { return false }
        AXUIElementSetMessagingTimeout(element, Float(min(0.04, remaining)))
        return true
    }
    func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        guard timeout(element) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
        return value
    }
    func axElement(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    func children(_ element: AXUIElement, key: String = "AXChildren") -> [AXUIElement] {
        guard let values = attribute(element, key) as? [AnyObject] else { return [] }
        return values.compactMap { axElement($0) }
    }
    func clean(_ value: CFTypeRef?) -> String {
        guard let string = value as? String else { return "" }
        return String(string.components(separatedBy: .newlines).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
    }
    func name(_ element: AXUIElement, secure: Bool = false) -> String {
        for key in ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXValue", "AXHelp"] {
            if secure && key == "AXValue" { continue }
            let text = clean(attribute(element, key))
            if !text.isEmpty { return text }
        }
        return ""
    }
    func descendantText(_ element: AXUIElement) -> String {
        var queue = children(element).map { ($0, 1) }
        var index = 0
        while index < queue.count && !expired {
            let (node, depth) = queue[index]
            index += 1
            if clean(attribute(node, "AXRole")) == "AXStaticText" {
                let text = name(node)
                if !text.isEmpty { return text }
            }
            if depth < 3 { queue.append(contentsOf: children(node).map { ($0, depth + 1) }) }
        }
        return ""
    }
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    if displayCount > 0 { _ = CGGetActiveDisplayList(displayCount, &displays, &displayCount) }
    let screens = displays.prefix(Int(displayCount)).map { CGDisplayBounds($0) }
    let app = NSWorkspace.shared.frontmostApplication
    var window = ""
    var elements: [[String: Any]] = []
    var truncated = false
    if let app = app {
        let application = AXUIElementCreateApplication(app.processIdentifier)
        if timeout(application) {
            _ = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        let bundle = app.bundleIdentifier ?? ""
        if ["com.google.Chrome", "com.brave", "com.microsoft.edgemac", "org.chromium"].contains(where: { bundle.hasPrefix($0) }),
           timeout(application) {
            _ = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        var queue: [AXUIElement] = []
        if let focused = axElement(attribute(application, "AXFocusedWindow")) {
            queue = [focused]
        } else if let main = axElement(attribute(application, "AXMainWindow")) {
            queue = [main]
        } else {
            queue = children(application, key: "AXWindows")
        }
        if let first = queue.first { window = attribute(first, "AXTitle") as? String ?? "" }
        let roles: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXSecureTextField", "AXTextArea",
            "AXSearchField", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuButton",
            "AXPopUpButton", "AXTab", "AXDisclosureTriangle", "AXRow", "AXCell"]
        let inputs: Set<String> = ["AXTextField", "AXSecureTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
        var visited = Set<AXUIElement>()
        var index = 0
        while index < queue.count && !expired {
            let node = queue[index]
            index += 1
            guard visited.insert(node).inserted else { continue }
            var role = clean(attribute(node, "AXRole"))
            let secure = role == "AXSecureTextField" || clean(attribute(node, "AXSubrole")) == "AXSecureTextField"
            if secure { role = "AXSecureTextField" }
            let enabled = attribute(node, "AXEnabled")
            let disabled = enabled.map { CFGetTypeID($0) == CFBooleanGetTypeID() && CFEqual($0, kCFBooleanFalse) } ?? false
            if roles.contains(role) && !disabled {
                let label = (role == "AXRow" || role == "AXCell") ? descendantText(node) : name(node, secure: secure)
                if !label.isEmpty || inputs.contains(role) {
                    let position = attribute(node, "AXPosition")
                    let size = attribute(node, "AXSize")
                    if let position = position, let size = size,
                       CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() {
                        let pointValue = unsafeBitCast(position, to: AXValue.self)
                        let sizeValue = unsafeBitCast(size, to: AXValue.self)
                        var point = CGPoint.zero
                        var dimensions = CGSize.zero
                        if AXValueGetType(pointValue) == .cgPoint, AXValueGetType(sizeValue) == .cgSize,
                           AXValueGetValue(pointValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &dimensions),
                           dimensions.width.isFinite, dimensions.height.isFinite,
                           dimensions.width >= 4, dimensions.height >= 4 {
                            let centre = CGPoint(x: point.x + dimensions.width / 2, y: point.y + dimensions.height / 2)
                            if centre.x.isFinite && centre.y.isFinite && screens.contains(where: { $0.contains(centre) }) {
                                elements.append(["role": role, "name": label, "x": centre.x, "y": centre.y,
                                                 "w": dimensions.width, "h": dimensions.height])
                            }
                        }
                    }
                }
            }
            // Fetch children before the cap check so a leaf at the cap can complete normally.
            queue.append(contentsOf: children(node))
            if elements.count >= maximum { break }
        }
        truncated = expired || index < queue.count
    }
    elements.sort {
        let ay = $0["y"] as! CGFloat, by = $1["y"] as! CGFloat
        return ay == by ? ($0["x"] as! CGFloat) < ($1["x"] as! CGFloat) : ay < by
    }
    for index in elements.indices { elements[index]["id"] = index + 1 }
    return ["ok": true, "app": app?.localizedName ?? "", "window": window, "elements": elements,
            "truncated": truncated || expired, "ms": (ProcessInfo.processInfo.systemUptime - started) * 1000]
}

func handle(_ line: String) throws -> [String: Any] {
    guard let data = line.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let op = object["op"] as? String else {
        throw CommandError.invalid("expected a JSON object with an op string")
    }
    switch op {
    case "ax_list":
        let maximum = object["max"] == nil ? 60 : Int(try integer(object, "max", range: 1...10000))
        let budget = object["budget_ms"] == nil ? 350 : Int(try integer(object, "budget_ms", range: 1...60000))
        return accessibilityList(maximum: maximum, budgetMS: budget)
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
