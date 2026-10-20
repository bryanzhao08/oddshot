// Generates the Tipoff app icon (1024x1024 PNG) with CoreGraphics only.
// Usage: swift ios/scripts/make_icon.swift <output.png>
import AppKit
import CoreGraphics

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
let s = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: s, height: s, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
let S = CGFloat(s)
// Background: near-black with subtle vertical gradient
let bg = CGGradient(colorsSpace: cs, colors: [
    CGColor(srgbRed: 0.07, green: 0.08, blue: 0.10, alpha: 1),
    CGColor(srgbRed: 0.02, green: 0.02, blue: 0.03, alpha: 1)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: S), end: CGPoint(x: 0, y: 0), options: [])

let lime = CGColor(srgbRed: 0.776, green: 1.0, blue: 0.18, alpha: 1)
let center = CGPoint(x: S / 2, y: S / 2)
// Faint track ring
ctx.setLineWidth(70)
ctx.setLineCap(.round)
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.08))
ctx.addArc(center: center, radius: 360, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.strokePath()
// Accent arc (gauge)
ctx.setStrokeColor(lime)
ctx.addArc(center: center, radius: 360, startAngle: .pi * 1.25, endAngle: -.pi * 0.05, clockwise: true)
ctx.strokePath()
// Spike line through the middle
ctx.setLineWidth(56)
ctx.setLineJoin(.round)
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
let pts: [CGPoint] = [(-260, -40), (-120, -40), (-50, -150), (40, 230), (120, -40), (260, -40)]
    .map { CGPoint(x: center.x + $0.0, y: center.y + $0.1) }
ctx.addLines(between: pts)
ctx.strokePath()
// Dot at the peak
ctx.setFillColor(lime)
ctx.fillEllipse(in: CGRect(x: center.x + 40 - 50, y: center.y + 230 - 50, width: 100, height: 100))

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
