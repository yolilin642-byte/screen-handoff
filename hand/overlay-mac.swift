// overlay-mac —— overlay.exe 的 mac 版：屏幕最上面那层「我」，字幕＋点下去的那一圈。CrossDesk 抓屏不带光标，所以自己画。
// 照 overlay.cs 对着写的，尺寸、颜色、时长都一样。**没编译过，没在 mac 上跑过。**
// stdin 一行一条（tab 分隔），跟 Windows 版同一套：
//   say <文字>   换字幕（空=收起）      wait <文字>   字幕换成等人的样子（印子变锈色）
//   tap x y      点击涟漪                at x y        手停在这儿（小点）        hide   全收
// 坐标是「点」，主屏左上角 0,0（跟 hand-mac 一样）。
// 两扇窗都标题 kael-overlay：hand-mac 截图时认这个名字把它们剔掉（layers 才拍）；CrossDesk 照样拍得到，连进来的人看得见。
// 编：swiftc -O overlay-mac.swift -o overlay-mac
import AppKit

let paper = NSColor(srgbRed: 238 / 255, green: 240 / 255, blue: 234 / 255, alpha: 236 / 255)
let ink = NSColor(srgbRed: 43 / 255, green: 46 / 255, blue: 42 / 255, alpha: 1)
let green = NSColor(srgbRed: 63 / 255, green: 107 / 255, blue: 90 / 255, alpha: 1)
let rust = NSColor(srgbRed: 150 / 255, green: 86 / 255, blue: 60 / 255, alpha: 1)
let sealInk = NSColor(srgbRed: 240 / 255, green: 238 / 255, blue: 230 / 255, alpha: 1)
let capFont = NSFont.systemFont(ofSize: 15)
let sealFont = NSFont(name: "Georgia-BoldItalic", size: 14) ?? NSFont.boldSystemFont(ofSize: 14)
let PAD_X: CGFloat = 14, PAD_Y: CGFloat = 8, SEAL: CGFloat = 22, GAP: CGFloat = 10, MARK: CGFloat = 90

func layer() -> NSWindow {
  let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: .borderless, backing: .buffered, defer: false)
  w.title = "kael-overlay"
  w.isOpaque = false
  w.backgroundColor = .clear
  w.hasShadow = false
  w.ignoresMouseEvents = true          // 点不中，鼠标穿过去
  w.level = .screenSaver               // 钉在最上面
  w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
  return w
}

// 主屏（有菜单栏那块）：AppKit 原点在左下，协议的 y 从上往下数
func flip(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
  let f = (NSScreen.screens.first ?? NSScreen.main!).frame
  return NSPoint(x: f.minX + x, y: f.maxY - y)
}

final class CaptionView: NSView {
  var text = ""
  var waiting = false
  override func draw(_ dirty: NSRect) {
    let b = bounds
    paper.setFill()
    NSBezierPath(roundedRect: b, xRadius: b.height / 2, yRadius: b.height / 2).fill()
    let sr = NSRect(x: PAD_X, y: (b.height - SEAL) / 2, width: SEAL, height: SEAL)
    (waiting ? rust : green).setFill()
    NSBezierPath(ovalIn: sr).fill()
    let k = NSAttributedString(string: "K", attributes: [.font: sealFont, .foregroundColor: sealInk])
    let ks = k.size()
    k.draw(at: NSPoint(x: sr.midX - ks.width / 2, y: sr.midY - ks.height / 2))
    let t = NSAttributedString(string: text, attributes: [.font: capFont, .foregroundColor: ink])
    t.draw(at: NSPoint(x: sr.maxX + GAP, y: (b.height - t.size().height) / 2))
  }
}

final class MarkView: NSView {
  var tapAt: Date? = nil
  var tapping = false
  override func draw(_ dirty: NSRect) {
    guard let at = tapAt else { return }
    let t = CGFloat(Date().timeIntervalSince(at) * 1000)
    let c = NSPoint(x: bounds.midX, y: bounds.midY), dot: CGFloat = 7
    let fade: CGFloat = tapping ? 1 : max(0, 1 - max(0, t - 1500) / 1000)
    green.withAlphaComponent(fade).setFill()
    NSBezierPath(ovalIn: NSRect(x: c.x - dot / 2, y: c.y - dot / 2, width: dot, height: dot)).fill()
    if tapping {
      let k = min(1, t / 900), r = 6 + k * (bounds.width / 2 - 8)
      let p = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
      p.lineWidth = 2.2
      green.withAlphaComponent(0.86 * (1 - k)).setStroke()
      p.stroke()
    }
  }
}

let app = NSApplication.shared
_ = app.setActivationPolicy(.accessory)
let capWin = layer(), capView = CaptionView()
capWin.contentView = capView
let markWin = layer(), markView = MarkView(frame: NSRect(x: 0, y: 0, width: MARK, height: MARK))
markWin.contentView = markView
markWin.setContentSize(NSSize(width: MARK, height: MARK))
var anim: Timer? = nil

func drawCaption(_ text: String, _ waiting: Bool) {
  if text.isEmpty { capWin.orderOut(nil); return }
  capView.text = text
  capView.waiting = waiting
  let ts = NSAttributedString(string: text, attributes: [.font: capFont]).size()
  let w = ceil(PAD_X * 2 + SEAL + GAP + ts.width), h = ceil(max(SEAL + PAD_Y * 2, ts.height + PAD_Y * 2))
  let f = (NSScreen.screens.first ?? NSScreen.main!).frame
  capWin.setFrame(NSRect(x: f.minX + (f.width - w) / 2, y: f.minY + 64, width: w, height: h), display: true)
  capView.needsDisplay = true
  capWin.orderFrontRegardless()
}

func mark(_ x: Int, _ y: Int, tapping: Bool) {
  markView.tapAt = Date()
  markView.tapping = tapping
  let p = flip(CGFloat(x), CGFloat(y))
  markWin.setFrameOrigin(NSPoint(x: p.x - MARK / 2, y: p.y - MARK / 2))
  markView.needsDisplay = true
  markWin.orderFrontRegardless()
  anim?.invalidate()
  anim = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { t in
    guard let at = markView.tapAt, Date().timeIntervalSince(at) * 1000 <= (markView.tapping ? 900 : 2500) else {
      t.invalidate(); markView.tapAt = nil; markWin.orderOut(nil); return
    }
    markView.needsDisplay = true
  }
}

func handle(_ a: [String]) {
  switch a[0] {
  case "say": drawCaption(a.count > 1 ? a[1] : "", false)
  case "wait": drawCaption(a.count > 1 ? a[1] : "你在用，我等着", true)
  case "tap", "at":
    if a.count > 2, let x = Int(a[1]), let y = Int(a[2]) { mark(x, y, tapping: a[0] == "tap") }
  case "hide":
    drawCaption("", false)
    anim?.invalidate(); markView.tapAt = nil; markWin.orderOut(nil)
  default: break
  }
}

Thread {
  while let line = readLine(strippingNewline: true) {
    let a = line.components(separatedBy: "\t")
    DispatchQueue.main.async { handle(a) }
  }
  DispatchQueue.main.async { NSApp.terminate(nil) }
}.start()
app.run()
