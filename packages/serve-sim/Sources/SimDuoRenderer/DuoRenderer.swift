import Foundation
import RealityKit
import Metal
import AppKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// Renders Apple's installed V68 asset; no Apple asset is copied into the package.
@MainActor final class DuoRenderer {
    private let renderer: RealityRenderer
    private let wrapper = Entity()
    private let rest = Entity()
    private let subject: Entity
    private let controller: AnimationPlaybackController
    private let texture: MTLTexture
    private let output: RealityRenderer.CameraOutput
    private let context: CIContext
    private let flatBounds: BoundingBox
    private let innerBounds: BoundingBox
    private let coverBounds: BoundingBox
    private let cameraDistance: Float
    private(set) var pieces: [[[Double]]] = []
    private let cover: (ModelEntity, Int)
    private let inner: (ModelEntity, Int)
    private var lastAngle: Double = .nan
    private var lastRoll: Double = .nan
    // Live preview: half of the studio still (was 2000×1800). Full size + 4× MSAA
    // + dual RealityKit passes + PNG was ~5–6 fps / ~500KB frames.
    let width = 1000
    let height = 900

    init(modelURL: URL) throws {
        let loaded = try Entity.load(contentsOf: modelURL)
        subject = loaded.findEntity(named: "root") ?? loaded
        guard let clip = subject.availableAnimations.first(where: { $0.name == "l_over_r" && $0.definition.duration.isFinite }),
              let cover = Self.screen(in: subject, named: "YqugYDOqMSOpqyA"),
              let inner = Self.screen(in: subject, named: "CvyXbAGXoolRUYl"),
              let device = MTLCreateSystemDefaultDevice() else {
            throw NSError(domain: "DuoRenderer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Duo model is missing its screens or folding animation"])
        }
        self.cover = cover
        self.inner = inner
        // The inner screen's framebuffer is authored a quarter turn around its UVs.
        try Self.rotateTexture(on: inner.0, material: inner.1)
        renderer = try RealityRenderer()
        subject.removeFromParent()
        rest.addChild(subject)
        wrapper.addChild(rest)
        rest.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        subject.position -= subject.visualBounds(relativeTo: rest).center
        flatBounds = subject.visualBounds(relativeTo: wrapper)
        innerBounds = Self.screenBounds(inner, relativeTo: wrapper)
        coverBounds = Self.screenBounds(cover, relativeTo: wrapper)
        cameraDistance = max(flatBounds.extents.x, flatBounds.extents.y) * 2.25
        renderer.entities.append(wrapper)
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 35
        camera.camera.near = 0.001
        camera.camera.far = 10000
        camera.position = [0, 0, cameraDistance]
        renderer.entities.append(camera)
        renderer.activeCamera = camera
        let light = DirectionalLight()
        light.light.intensity = 5000
        light.look(at: [0, 0, 0], from: [1, 2, 3], relativeTo: nil)
        renderer.entities.append(light)
        let fill = DirectionalLight()
        fill.light.intensity = 1500
        fill.look(at: [0, 0, 0], from: [-2, 1, 3], relativeTo: nil)
        renderer.entities.append(fill)
        renderer.cameraSettings.antialiasing = .none
        renderer.cameraSettings.colorBackground = .color(CGColor(red: 0, green: 0, blue: 0, alpha: 0))
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: width, height: height, mipmapped: false)
        descriptor.storageMode = .shared
        descriptor.usage = [.renderTarget, .shaderRead]
        guard let texture = device.makeTexture(descriptor: descriptor) else { throw CocoaError(.fileReadUnknown) }
        self.texture = texture
        output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        context = CIContext(mtlDevice: device)
        controller = subject.playAnimation(clip, transitionDuration: 0, startsPaused: true)
    }

    func render(jpeg: Data, panel: String, angle: Double, roll: Double) async throws -> Data {
        guard angle.isFinite, (0...180).contains(angle), roll.isFinite,
              let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw CocoaError(.fileReadCorruptFile) }
        let slot = panel == "cover" ? cover : inner
        var material = UnlitMaterial(applyPostProcessToneMap: false)
        material.color = .init(tint: .white, texture: .init(try TextureResource.generate(from: image, options: .init(semantic: .color))))
        slot.0.model!.materials[slot.1] = material
        let raise = Float((180 - angle) * .pi / 180)
        // Keep the book planted: hinge motion comes only from the fold clip.
        // Angle-linked yaw spun the whole model while pinching closed.
        controller.time = (180 - angle) / 180 * 5
        rest.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        wrapper.orientation = simd_quatf(angle: Float(roll * .pi / 180), axis: [0, 0, 1])
        // Keep the bent body's horizontal extent centred as the left leaf closes.
        let fold = simd_quatf(angle: raise, axis: [0, 1, 0])
        let half = flatBounds.extents.x / 2
        let points: [SIMD3<Float>] = [fold.act([-half, 0, 0]), [0, 0, 0], [half, 0, 0]]
        let xs = points.map(\.x)
        rest.position.x = -((xs.min() ?? 0) + (xs.max() ?? 0)) / 2
        let rollRotation = wrapper.orientation
        func project(_ p: SIMD3<Float>, folded: Bool) -> [Double] {
            var point = folded ? fold.act(p) : p
            point.x += rest.position.x
            point = rollRotation.act(point)
            let depth = max(0.001, cameraDistance - point.z)
            let scale: Float = 1 / tan(35 * .pi / 360)
            return [Double(0.5 + point.x * scale / depth / (Float(width) / Float(height)) / 2),
                    Double(0.5 - point.y * scale / depth / 2)]
        }
        let b = panel == "cover" ? coverBounds : innerBounds
        let z = panel == "cover" ? b.min.z : b.max.z
        let top = b.max.y, bottom = b.min.y
        if panel == "cover" {
            // Cover UVs face away in the flat model, and face the viewer after folding.
            pieces = [[project([b.max.x, top, z], folded: true), project([b.min.x, top, z], folded: true),
                       project([b.min.x, bottom, z], folded: true), project([b.max.x, bottom, z], folded: true),
                       [0, 0, 1, 1]]]
        } else {
            // Inner UVs are landscape-left: raw top-left is visual top-right.
            pieces = [[project([0, top, z], folded: false), project([0, bottom, z], folded: false),
                       project([b.min.x, bottom, z], folded: true), project([b.min.x, top, z], folded: true), [0, 0.5, 1, 0.5]],
                      [project([b.max.x, top, z], folded: false), project([b.max.x, bottom, z], folded: false),
                       project([0, bottom, z], folded: false), project([0, top, z], folded: false), [0, 0, 1, 0.5]]]
        }
        // Advancing the paused clip's time takes an update before skinning settles.
        // Texture-only frames (same hinge/roll) only need one pass.
        let poseChanged = lastAngle != angle || lastRoll != roll
        lastAngle = angle
        lastRoll = roll
        let passes = poseChanged ? 2 : 1
        for _ in 0..<passes {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                do {
                    try renderer.updateAndRender(deltaTime: 1 / 60, cameraOutput: output, onComplete: { _ in continuation.resume() })
                } catch { continuation.resume(throwing: error) }
            }
        }
        guard let rendered = CIImage(mtlTexture: texture, options: [.colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])?.oriented(.downMirrored),
              let cg = context.createCGImage(rendered, from: rendered.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) else { throw CocoaError(.fileReadUnknown) }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw CocoaError(.fileWriteUnknown) }
        CGImageDestinationAddImage(destination, cg, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
        return data as Data
    }

    private static func screenBounds(_ slot: (ModelEntity, Int), relativeTo reference: Entity) -> BoundingBox {
        var box: BoundingBox?
        for mesh in slot.0.model!.mesh.contents.models {
            for part in mesh.parts where part.materialIndex == slot.1 {
                for position in part.positions.elements {
                    let point = slot.0.convert(position: position, to: reference)
                    if box == nil { box = BoundingBox(min: point, max: point) }
                    else { box!.formUnion(BoundingBox(min: point, max: point)) }
                }
            }
        }
        return box ?? slot.0.visualBounds(relativeTo: reference)
    }

    private static func screen(in entity: Entity, named name: String) -> (ModelEntity, Int)? {
        if let model = entity as? ModelEntity, let index = model.model?.materials.firstIndex(where: { $0.name == name }) { return (model, index) }
        for child in entity.children { if let result = screen(in: child, named: name) { return result } }
        return nil
    }

    private static func rotateTexture(on entity: ModelEntity, material: Int) throws {
        guard let model = entity.model else { return }
        var contents = model.mesh.contents
        contents.models = .init(contents.models.map { mesh in
            var mesh = mesh
            mesh.parts = .init(mesh.parts.map { part in
                guard part.materialIndex == material, let coordinates = part.textureCoordinates else { return part }
                var part = part
                part.textureCoordinates = .init(coordinates.elements.map { SIMD2<Float>(1 - $0.y, $0.x) })
                return part
            })
            return mesh
        })
        try model.mesh.replace(with: contents)
        entity.model = model
    }
}
