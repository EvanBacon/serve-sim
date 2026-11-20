// Touch probe for serve-sim touch-reliability measurements (iPhone Duo).
//
// Records every UITouch phase the app receives as one JSON line in
// Documents/touches.jsonl: location in window points, normalized 0..1 of the
// window, the same point in the screen's fixed (native portrait) coordinate
// space, which screen/scene it arrived on, interface orientation, and both a
// monotonic (systemUptime) and wall-clock timestamp. Scene connect/geometry
// changes are logged as "scene" lines so a harness can see which display the
// app is on. Build with ./build.sh; nothing here is shipped with serve-sim.
import UIKit

final class ProbeLog {
    static let shared = ProbeLog()
    private let queue = DispatchQueue(label: "probe-log")
    private var handle: FileHandle?
    private var seq = 0

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docs.appendingPathComponent("touches.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
    }

    func write(_ object: [String: Any]) {
        queue.async {
            self.seq += 1
            var line = object
            line["seq"] = self.seq
            line["pid"] = ProcessInfo.processInfo.processIdentifier
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
            self.handle?.write(data)
            self.handle?.write("\n".data(using: .utf8)!)
            try? self.handle?.synchronize()
        }
    }
}

func orientationName(_ o: UIInterfaceOrientation) -> String {
    switch o {
    case .portrait: return "portrait"
    case .portraitUpsideDown: return "portrait_upside_down"
    case .landscapeLeft: return "landscape_left"
    case .landscapeRight: return "landscape_right"
    default: return "unknown"
    }
}

func screenInfo(_ scene: UIWindowScene?) -> [String: Any] {
    guard let scene else { return [:] }
    let screen = scene.screen
    let native = screen.nativeBounds.size
    let w = Int(native.width.rounded()), h = Int(native.height.rounded())
    let sorted = [w, h].sorted()
    let display: String
    if sorted == [1398, 2034] { display = "cover" }
    else if sorted == [2007, 2853] { display = "inner" }
    else { display = "other:\(w)x\(h)" }
    var info: [String: Any] = [
        "display": display,
        "screenNative": [w, h],
        "screenBounds": [screen.bounds.width, screen.bounds.height],
        "screenScale": screen.scale,
        "screenDesc": String(describing: screen).components(separatedBy: ";").prefix(2).joined(separator: ";"),
        "sceneRole": scene.session.role.rawValue,
        "sceneId": scene.session.persistentIdentifier,
        "orientation": orientationName(scene.effectiveGeometry.interfaceOrientation),
    ]
    return info
}

final class ProbeWindow: UIWindow {
    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches, let touches = event.allTouches {
            let all = Array(touches)
            for touch in all {
                let phase: String
                switch touch.phase {
                case .began: phase = "began"
                case .moved: phase = "moved"
                case .stationary: phase = "stationary"
                case .ended: phase = "ended"
                case .cancelled: phase = "cancelled"
                default: phase = "other"
                }
                if phase == "stationary" { continue }
                let p = touch.location(in: self)
                let size = bounds.size
                var line: [String: Any] = [
                    "kind": "touch",
                    "phase": phase,
                    "touchId": UInt(bitPattern: ObjectIdentifier(touch).hashValue),
                    "touchCount": all.count,
                    "x": Double(p.x), "y": Double(p.y),
                    "nx": size.width > 0 ? Double(p.x / size.width) : -1,
                    "ny": size.height > 0 ? Double(p.y / size.height) : -1,
                    "window": [size.width, size.height],
                    "uptime": touch.timestamp,
                    "now": ProcessInfo.processInfo.systemUptime,
                    "wall": Date().timeIntervalSince1970,
                    "tapCount": touch.tapCount,
                ]
                if let screen = windowScene?.screen {
                    let fixed = convert(p, to: screen.fixedCoordinateSpace)
                    let fb = screen.fixedCoordinateSpace.bounds.size
                    line["fx"] = Double(fixed.x / fb.width)
                    line["fy"] = Double(fixed.y / fb.height)
                }
                line.merge(screenInfo(windowScene)) { a, _ in a }
                ProbeLog.shared.write(line)
            }
        }
        super.sendEvent(event)
    }
}

final class ProbeView: UIView {
    private let label = UILabel()
    private var dots: [CGPoint] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(red: 0.08, green: 0.1, blue: 0.16, alpha: 1)
        isMultipleTouchEnabled = true
        label.numberOfLines = 0
        label.textColor = .white
        label.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        addSubview(label)
    }
    required init?(coder: NSCoder) { fatalError() }

    func refresh() {
        let info = screenInfo(window?.windowScene)
        label.text = "touchprobe\n\(info["display"] ?? "?") \(info["orientation"] ?? "?")\nwindow \(Int(bounds.width))x\(Int(bounds.height))\ntouches \(dots.count)"
        label.frame = bounds.insetBy(dx: 24, dy: 80).divided(atDistance: 120, from: .minYEdge).slice
        setNeedsDisplay()
    }

    override func layoutSubviews() { super.layoutSubviews(); refresh() }

    override func draw(_ rect: CGRect) {
        let ctx = UIGraphicsGetCurrentContext()!
        // Reference grid at 10% steps.
        ctx.setStrokeColor(UIColor(white: 1, alpha: 0.25).cgColor)
        for i in 1..<10 {
            let x = bounds.width * CGFloat(i) / 10, y = bounds.height * CGFloat(i) / 10
            ctx.move(to: CGPoint(x: x, y: 0)); ctx.addLine(to: CGPoint(x: x, y: bounds.height))
            ctx.move(to: CGPoint(x: 0, y: y)); ctx.addLine(to: CGPoint(x: bounds.width, y: y))
        }
        ctx.strokePath()
        ctx.setFillColor(UIColor.systemOrange.cgColor)
        for p in dots.suffix(60) { ctx.fillEllipse(in: CGRect(x: p.x - 8, y: p.y - 8, width: 16, height: 16)) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { dots.append(t.location(in: self)) }
        refresh()
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { dots.append(t.location(in: self)) }
        if dots.count > 400 { dots.removeFirst(dots.count - 400) }
        setNeedsDisplay()
    }
}

final class ProbeViewController: UIViewController {
    override func loadView() { view = ProbeView() }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }
    override var prefersHomeIndicatorAutoHidden: Bool { false }
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { _ in (self.view as? ProbeView)?.refresh() }
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = ProbeWindow(windowScene: windowScene)
        window.rootViewController = ProbeViewController()
        window.makeKeyAndVisible()
        self.window = window
        var line: [String: Any] = ["kind": "scene", "event": "connect", "wall": Date().timeIntervalSince1970,
                                   "window": [window.bounds.width, window.bounds.height]]
        line.merge(screenInfo(windowScene)) { a, _ in a }
        ProbeLog.shared.write(line)
    }

    func windowScene(_ windowScene: UIWindowScene, didUpdate previousCoordinateSpace: UICoordinateSpace,
                     interfaceOrientation previousInterfaceOrientation: UIInterfaceOrientation,
                     traitCollection previousTraitCollection: UITraitCollection) {
        var line: [String: Any] = ["kind": "scene", "event": "geometry", "wall": Date().timeIntervalSince1970,
                                   "window": [window?.bounds.width ?? 0, window?.bounds.height ?? 0]]
        line.merge(screenInfo(windowScene)) { a, _ in a }
        ProbeLog.shared.write(line)
        (window?.rootViewController?.view as? ProbeView)?.refresh()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        var line: [String: Any] = ["kind": "scene", "event": "active", "wall": Date().timeIntervalSince1970]
        line.merge(screenInfo(scene as? UIWindowScene)) { a, _ in a }
        ProbeLog.shared.write(line)
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        ProbeLog.shared.write(["kind": "launch", "wall": Date().timeIntervalSince1970])
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
