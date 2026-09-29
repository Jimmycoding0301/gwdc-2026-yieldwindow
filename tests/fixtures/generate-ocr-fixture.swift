import AppKit
let size = NSSize(width: 1100, height: 660)
let image = NSImage(size: size)
image.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: size).fill()
let rows = ["YieldWindow seller settlement — synthetic", "USDT 90000", "USDD 10000", "Horizon: 4 days", "Seller payment: 68000 USDT", "Refund / logistics buffer: 12000 USDT", "Need in: 4 days 80000 USDT"]
for (index, row) in rows.enumerated() {
  let font = NSFont.systemFont(ofSize: index == 0 ? 25 : 34, weight: .medium)
  let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
  (row as NSString).draw(at: NSPoint(x: 65, y: 590 - index * 82), withAttributes: attrs)
}
image.unlockFocus()
guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
