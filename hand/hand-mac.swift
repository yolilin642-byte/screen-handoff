// hand-mac —— hand.exe 的 mac 版：屏幕那扇窗的手和眼。同一套一问一答（命令和回话见 hand.cs 文件头），server.mjs 在 mac 上拉它。
// 照 hand.cs 一样样对着写的。**没编译过，没在 mac 上跑过。**
//
// 跟 Windows 版不一样的地方：
//   坐标一律用「点」（macOS 全局坐标，主屏左上角是 0,0），不是物理像素；Retina 屏截图按点的大小出。只管主屏。
//   截图用 ScreenCaptureKit（SCScreenshotManager），要 macOS 14 以上；默认不拍 overlay-mac 那层（标题 kael-overlay），layers 才拍。
//   谁按的：我们注入的事件 eventSourceUserData 写 'KAEL'，一个只听不改的事件 tap 记下不是我们的那一下。
//   key 认的名字多了 cmd/command/option；win/meta 当 command。
// 权限（系统设置 → 隐私与安全性），授给拉起它的那个程序（从终端起就授给终端，从 launchd 起 node 就授给 node）：
//   屏幕录制：截图、读窗口标题。辅助功能：动鼠标键盘、把窗拎到前面。输入监控：听谁在按（lastinput）。
// 编：xcode-select --install 之后  swiftc -O hand-mac.swift -o hand-mac
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct HandErr: Error { let m: String; init(_ m: String) { self.m = m } }

let MARK: Int64 = 0x4B41454C // 'KAEL'
let state = NSLock()
var lastOurs: UInt64 = 0      // 我们最后一次注入（开机以来的毫秒）
var otherTick: UInt64 = 0     // 最后一次不是我们按的
var otherSeen = false
var monitorReady = false
var tapRef: CFMachPort? = nil
var leftDown = false, rightDown = false
let src = CGEventSource(stateID: .hidSystemState)

func nowMs() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }

let outH = FileHandle.standardOutput
func reply(_ head: String, _ body: Data? = nil) {
  var d = Data((head + "\n").utf8)
  if let b = body { d.append(b) }
  outH.write(d)
}

func I(_ s: String) throws -> Int {
  guard let v = Int(s.trimmingCharacters(in: .whitespaces)) else { throw HandErr("不是数字 \(s)") }
  return v
}

func screenSize() -> (Int, Int) {
  let b = CGDisplayBounds(CGMainDisplayID())
  return (Int(b.width), Int(b.height))
}

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

// —— 谁按的 ——
func startMonitor() {
  let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                              .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
                              .scrollWheel, .keyDown, .keyUp, .flagsChanged]
  var mask: CGEventMask = 0
  for t in types { mask |= CGEventMask(1) << CGEventMask(t.rawValue) }
  let cb: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    if event.getIntegerValueField(.eventSourceUserData) != MARK {
      state.lock(); otherTick = nowMs(); otherSeen = true; state.unlock()
    }
    return Unmanaged.passUnretained(event)
  }
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                    eventsOfInterest: mask, callback: cb, userInfo: nil) else { return }
  tapRef = tap
  let rl = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), rl, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  monitorReady = true
}

// —— 手 ——
func needAX() throws {
  if !AXIsProcessTrusted() { throw HandErr("没有辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能") }
}

func post(_ e: CGEvent?) throws {
  guard let e = e else { throw HandErr("事件造不出来") }
  e.setIntegerValueField(.eventSourceUserData, value: MARK)
  e.post(tap: .cghidEventTap)
  state.lock(); lastOurs = nowMs(); state.unlock()
}

func clampPoint(_ x: Int, _ y: Int) -> CGPoint {
  let (sw, sh) = screenSize()
  return CGPoint(x: max(0, min(sw - 1, x)), y: max(0, min(sh - 1, y)))
}

func moveTo(_ x: Int, _ y: Int) throws {
  try needAX()
  let p = clampPoint(x, y)
  let type: CGEventType = leftDown ? .leftMouseDragged : (rightDown ? .rightMouseDragged : .mouseMoved)
  try post(CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: rightDown && !leftDown ? .right : .left))
}

func button(_ which: String, _ down: Bool, clickState: Int64 = 1) throws {
  try needAX()
  let p = cursor()
  let type: CGEventType, btn: CGMouseButton
  switch which {
  case "right": type = down ? .rightMouseDown : .rightMouseUp; btn = .right
  case "middle": type = down ? .otherMouseDown : .otherMouseUp; btn = .center
  default: type = down ? .leftMouseDown : .leftMouseUp; btn = .left
  }
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: btn)
  e?.setIntegerValueField(.mouseEventClickState, value: clickState)
  try post(e)
  if which == "right" { rightDown = down } else if which != "middle" { leftDown = down }
}

// kVK_*（Carbon 的 Events.h），美式键盘
let KEY: [String: CGKeyCode] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
  "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
  "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D, "o": 0x1F, "u": 0x20, "i": 0x22,
  "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
  "equal": 0x18, "=": 0x18, "plus": 0x18, "minus": 0x1B, "-": 0x1B, "bracketright": 0x1E, "]": 0x1E,
  "bracketleft": 0x21, "[": 0x21, "quote": 0x27, "'": 0x27, "semicolon": 0x29, ";": 0x29, "backslash": 0x2A, "\\": 0x2A,
  "comma": 0x2B, ",": 0x2B, "slash": 0x2C, "/": 0x2C, "period": 0x2F, ".": 0x2F, "backquote": 0x32, "`": 0x32,
  "enter": 0x24, "return": 0x24, "tab": 0x30, "space": 0x31, "backspace": 0x33, "esc": 0x35, "escape": 0x35,
  "delete": 0x75, "del": 0x75, "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79, "insert": 0x72,
  "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E, "capslock": 0x39,
  "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65,
  "f10": 0x6D, "f11": 0x67, "f12": 0x6F, "f13": 0x69, "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40,
  "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
]
let MOD: [String: (CGKeyCode, CGEventFlags)] = [
  "cmd": (0x37, .maskCommand), "command": (0x37, .maskCommand), "win": (0x37, .maskCommand), "meta": (0x37, .maskCommand),
  "shift": (0x38, .maskShift), "alt": (0x3A, .maskAlternate), "option": (0x3A, .maskAlternate),
  "ctrl": (0x3B, .maskControl), "control": (0x3B, .maskControl),
]

func keyEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) throws {
  let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
  e?.flags = flags
  try post(e)
}

func key(_ combo: String) throws {
  try needAX()
  var mods: [(CGKeyCode, CGEventFlags)] = []
  var main: CGKeyCode? = nil
  for raw in combo.split(separator: "+") {
    let k = raw.trimmingCharacters(in: .whitespaces).lowercased()
    if let m = MOD[k] { mods.append(m); continue }
    guard main == nil, let c = KEY[k] else { throw HandErr("不认识的键 \(k)") }
    main = c
  }
  var flags: CGEventFlags = []
  for m in mods { flags.insert(m.1); try keyEvent(m.0, true, flags) }
  if let c = main { try keyEvent(c, true, flags); try keyEvent(c, false, flags) }
  for m in mods.reversed() { flags.remove(m.1); try keyEvent(m.0, false, flags) }
}

func typeText(_ s: String) throws {
  try needAX()
  for ch in s {
    if ch == "\r" { continue }
    if ch == "\n" || ch == "\r\n" { try keyEvent(0x24, true, []); try keyEvent(0x24, false, []); continue }
    if ch == "\t" { try keyEvent(0x30, true, []); try keyEvent(0x30, false, []); continue }
    let u = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      try post(e)
    }
    usleep(2000)
  }
}

// —— 窗 ——
func windowList() -> [[String: Any]] {
  (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}
func isNormal(_ w: [String: Any]) -> Bool {
  (w[kCGWindowLayer as String] as? Int ?? 1) == 0 && (w[kCGWindowOwnerName as String] as? String) != "overlay-mac"
}
func boundsOf(_ w: [String: Any]) -> CGRect? {
  guard let d = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: d as CFDictionary)
}
func rectOf(_ w: [String: Any]?) -> String {
  let (sw, sh) = screenSize()
  var r = CGRect(x: 0, y: 0, width: sw, height: sh), cls = "Desktop"
  if let w = w, let b = boundsOf(w) { r = b; cls = (w[kCGWindowOwnerName as String] as? String) ?? "-" }
  var l = max(0, Int(r.minX)), t = max(0, Int(r.minY)), rr = min(sw, Int(r.maxX)), bb = min(sh, Int(r.maxY))
  if rr - l < 40 || bb - t < 40 { l = 0; t = 0; rr = sw; bb = sh }
  return "OK\t\(l)\t\(t)\t\(rr)\t\(bb)\t\(cls.replacingOccurrences(of: "\t", with: " "))"
}

func win(_ x: Int, _ y: Int) {
  let list = windowList().filter(isNormal)
  if x < 0 {
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    reply(rectOf(list.first { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }))
  } else {
    let p = CGPoint(x: x, y: y)
    reply(rectOf(list.first { boundsOf($0)?.contains(p) ?? false }))
  }
}

// 按标题（或程序名）里的一截找那扇窗：程序拎到前台，再用辅助功能把那一扇 raise
func front(_ want: String) throws {
  let list = windowList().filter(isNormal)
  guard let hit = list.first(where: {
    (($0[kCGWindowName as String] as? String) ?? "").localizedCaseInsensitiveContains(want) ||
    (($0[kCGWindowOwnerName as String] as? String) ?? "").localizedCaseInsensitiveContains(want)
  }), let pid = hit[kCGWindowOwnerPID as String] as? Int32 else { reply("ERR\tno window: \(want)"); return }
  let app = NSRunningApplication(processIdentifier: pid)
  app?.unhide()
  app?.activate(options: [.activateIgnoringOtherApps])
  let ax = AXUIElementCreateApplication(pid)
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &v) == .success, let wins = v as? [AXUIElement] {
    let title = (hit[kCGWindowName as String] as? String) ?? ""
    for w in wins {
      var t: CFTypeRef?
      AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
      let s = (t as? String) ?? ""
      if (!title.isEmpty && s == title) || s.localizedCaseInsensitiveContains(want) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        break
      }
    }
  }
  usleep(150_000)
  let fg = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
  reply(rectOf(hit) + (fg ? "\tfg" : "\ttop"))
}

// —— 眼 ——
func capture(_ rect: CGRect, _ tw: Int, _ th: Int, layers: Bool) throws -> CGImage {
  let sem = DispatchSemaphore(value: 0)
  var img: CGImage? = nil
  var fail = "截图失败"
  SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
    guard let content = content,
          let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
      fail = "没拿到屏幕（屏幕录制权限给了吗）: \(error?.localizedDescription ?? "?")"; sem.signal(); return
    }
    let skip = layers ? [] : content.windows.filter {
      $0.title == "kael-overlay" || ($0.owningApplication?.applicationName ?? "") == "overlay-mac"
    }
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = rect
    cfg.width = tw; cfg.height = th
    cfg.showsCursor = false
    SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: skip),
                                     configuration: cfg) { image, error in
      img = image
      if image == nil { fail = "截图失败: \(error?.localizedDescription ?? "?")" }
      sem.signal()
    }
  }
  if sem.wait(timeout: .now() + 10) == .timedOut { throw HandErr("截图超时") }
  guard let i = img else { throw HandErr(fail) }
  return i
}

// 只看 RGB，FNV-1a，跟 hand.cs 一个算法（同一张图两边的数不保证一样，只在同一台机器上比前后）
func hashOf(_ img: CGImage) -> String {
  let w = img.width, h = img.height
  var buf = [UInt8](repeating: 0, count: w * h * 4)
  buf.withUnsafeMutableBytes { p in
    if let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                           space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
  }
  var hsh: UInt64 = 1469598103934665603
  var i = 0
  while i < buf.count {
    hsh = (hsh ^ UInt64(buf[i])) &* 1099511628211
    hsh = (hsh ^ UInt64(buf[i + 1])) &* 1099511628211
    hsh = (hsh ^ UInt64(buf[i + 2])) &* 1099511628211
    i += 4
  }
  return String(format: "%016llx", hsh)
}

func jpeg(_ img: CGImage, _ q: Int) throws -> Data {
  let data = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
    throw HandErr("JPEG 编不了")
  }
  let opts = [kCGImageDestinationLossyCompressionQuality: Double(max(10, min(95, q))) / 100.0] as CFDictionary
  CGImageDestinationAddImage(dest, img, opts)
  guard CGImageDestinationFinalize(dest) else { throw HandErr("JPEG 编不了") }
  return data as Data
}

func frame(_ x0: Int, _ y0: Int, _ w0: Int, _ h0: Int, _ tw0: Int, _ th0: Int, _ q: Int, _ since: String, _ layers: Bool) throws {
  let (sw, sh) = screenSize()
  let x = max(0, x0), y = max(0, y0)
  let w = min(w0, sw - x), h = min(h0, sh - y)
  if w < 1 || h < 1 { reply("ERR\tempty region"); return }
  let tw = tw0 < 1 || th0 < 1 ? w : tw0, th = tw0 < 1 || th0 < 1 ? h : th0
  let p = cursor()
  let img = try capture(CGRect(x: x, y: y, width: w, height: h), tw, th, layers: layers)
  let hash = hashOf(img)
  if hash == since { reply("SAME\t\(hash)\t\(Int(p.x))\t\(Int(p.y))"); return }
  let bytes = try jpeg(img, q)
  reply("JPEG\t\(bytes.count)\t\(hash)\t\(Int(p.x))\t\(Int(p.y))", bytes)
}

// —— 一问一答 ——
func handle(_ a: [String]) throws {
  func arg(_ i: Int) throws -> String { guard i < a.count else { throw HandErr("少参数") }; return a[i] }
  switch a[0] {
  case "ping": reply("OK")
  case "screen":
    let (sw, sh) = screenSize(), p = cursor()
    reply("OK\t\(sw)\t\(sh)\t\(Int(p.x))\t\(Int(p.y))")
  case "frame":
    try frame(I(arg(1)), I(arg(2)), I(arg(3)), I(arg(4)), I(arg(5)), I(arg(6)), I(arg(7)),
              a.count > 8 ? a[8] : "", a.count > 9 && a[9] == "layers")
  case "move": try moveTo(I(arg(1)), I(arg(2))); reply("OK")
  case "button": try button(arg(1), arg(2) == "down"); reply("OK")
  case "click":
    try moveTo(I(arg(1)), I(arg(2)))
    usleep(15_000)
    let which = try arg(3)
    let n = try a.count > 4 ? I(a[4]) : 1
    for i in 0..<max(1, n) {
      try button(which, true, clickState: Int64(i + 1)); usleep(10_000)
      try button(which, false, clickState: Int64(i + 1)); if i < n - 1 { usleep(40_000) }
    }
    reply("OK")
  case "scroll":
    try moveTo(I(arg(1)), I(arg(2)))
    usleep(10_000)
    let clicks = try Int32(I(arg(3)))
    let horiz = a.count > 4 && a[4] == "h"
    // Windows：clicks>0 往下 / 往右。mac 的 wheel1 正数是往上、wheel2 正数是往左，所以取反（没在真机上对过方向）
    try post(CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                     wheel1: horiz ? 0 : -clicks, wheel2: horiz ? -clicks : 0, wheel3: 0))
    reply("OK")
  case "key": try key(arg(1)); reply("OK")
  case "text":
    guard let d = Data(base64Encoded: try arg(1)), let s = String(data: d, encoding: .utf8) else { throw HandErr("text 不是 base64 的 UTF-8") }
    try typeText(s); reply("OK")
  case "lastinput":
    if !monitorReady { throw HandErr("input monitor unavailable") }
    let any = CGEventType(rawValue: ~UInt32(0))!
    let idle = Int(CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any) * 1000)
    let now = nowMs()
    state.lock(); let ours = lastOurs, other = otherTick, seen = otherSeen; state.unlock()
    reply("OK\t\(idle)\t\(ours == 0 ? -1 : Int(now - ours))\t\(seen ? Int(now - other) : -1)")
  case "win": try win(I(arg(1)), I(arg(2)))
  case "front": try front(arg(1))
  default: reply("ERR\tunknown command \(a[0])")
  }
}

_ = NSApplication.shared
_ = NSApp.setActivationPolicy(.prohibited)
startMonitor()
src?.userData = MARK
Thread {
  while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    let a = line.components(separatedBy: "\t")
    do { try handle(a) } catch let e as HandErr {
      reply("ERR\t" + e.m.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " "))
    } catch {
      reply("ERR\t\(error)".replacingOccurrences(of: "\n", with: " "))
    }
  }
  exit(0)
}.start()
CFRunLoopRun()
