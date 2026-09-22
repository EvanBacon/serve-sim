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
    private let targets: [(texture: MTLTexture, output: RealityRenderer.CameraOutput)]
    private var targetIndex = 0
    private var texture: MTLTexture { targets[targetIndex].texture }
    private var output: RealityRenderer.CameraOutput { targets[targetIndex].output }
    private let context: CIContext
    private let flatBounds: BoundingBox
    private let cameraDistance: Float
    private(set) var pieces: [[[Double]]] = []
    private let coverProjection: DuoScreenProjection
    private let innerProjection: DuoScreenProjection
    private let cover: (ModelEntity, Int)
    private let inner: (ModelEntity, Int)
    private var screenTextures: [String: TextureResource] = [:]
    private var screenFrames: [String: Data] = [:]
    private var lastAngle: Double = .nan
    private var lastRoll: Double = .nan
    // Preserve fine screen detail on Retina displays and antialias the shell.
    var width: Int { texture.width }
    var height: Int { texture.height }
    // Use Device Hub's 36 mm sensor model with a longer lens to flatten depth.
    private let fieldOfView: Float = 2 * atan(36 / (2 * 200.0)) * 180 / .pi

    init(modelURL: URL) async throws {
        // Load the folding geometry, then apply Device Hub's neutral shell palette.
        let catalog = try await Entity.ConfigurationCatalog(from: modelURL)
        let loaded = try await Entity(from: catalog, configurations: ["color": "Dark"])
        subject = loaded.findEntity(named: "root") ?? loaded
        guard let clip = subject.availableAnimations.first(where: { $0.name == "l_over_r" && $0.definition.duration.isFinite }),
              let cover = Self.screen(in: subject, named: "YqugYDOqMSOpqyA"),
              let inner = Self.screen(in: subject, named: "CvyXbAGXoolRUYl"),
              let device = MTLCreateSystemDefaultDevice() else {
            throw NSError(domain: "DuoRenderer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Duo model is missing its screens or folding animation"])
        }
        DuoShellMaterials.apply(to: subject)
        self.cover = cover
        self.inner = inner
        // The inner screen's framebuffer is authored a quarter turn around its UVs.
        try Self.rotateTexture(on: inner.0, material: inner.1)
        coverProjection = try DuoScreenProjection(slot: cover, inner: false)
        innerProjection = try DuoScreenProjection(slot: inner, inner: true)
        renderer = try RealityRenderer()
        subject.removeFromParent()
        rest.addChild(subject)
        wrapper.addChild(rest)
        rest.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        subject.position -= subject.visualBounds(relativeTo: rest).center
        flatBounds = subject.visualBounds(relativeTo: wrapper)
        cameraDistance = max(flatBounds.extents.x, flatBounds.extents.y) * 1.8 * tan(35 * .pi / 360) / tan(fieldOfView * .pi / 360)
        renderer.entities.append(wrapper)
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = fieldOfView
        camera.camera.near = 0.001
        camera.camera.far = 10000
        camera.position = [0, 0, cameraDistance]
        renderer.entities.append(camera)
        renderer.activeCamera = camera
        renderer.lighting.resource = EnvironmentResource.duoObjectLighting()
        renderer.cameraSettings.antialiasing = .multisample4X
        renderer.cameraSettings.colorBackground = .color(CGColor(red: 0, green: 0, blue: 0, alpha: 0))
        // Keep both targets allocated: resizing during gestures would stall Metal.
        targets = try [1500, 3000].map { width in
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: width, height: width * 9 / 10, mipmapped: false)
            descriptor.storageMode = .shared
            descriptor.usage = [.renderTarget, .shaderRead]
            guard let texture = device.makeTexture(descriptor: descriptor) else { throw CocoaError(.fileReadUnknown) }
            return (texture, try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture)))
        }
        context = CIContext(mtlDevice: device)
        controller = subject.playAnimation(clip, transitionDuration: 0, startsPaused: true)
    }

    func render(jpeg: Data, panel: String, angle: Double, roll: Double, fullResolution: Bool = true) async throws -> Data {
        targetIndex = fullResolution ? 1 : 0
        guard angle.isFinite, (0...180).contains(angle), roll.isFinite else { throw CocoaError(.fileReadCorruptFile) }
        // Hinge, rotation, and idle sharpening often reuse the same framebuffer.
        // Keep both panel textures alive and skip image decoding/upload entirely.
        if screenFrames[panel] != jpeg {
            guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw CocoaError(.fileReadCorruptFile) }
            if let existing = screenTextures[panel] {
                try await existing.replace(using: image, options: .init(semantic: .color))
            } else {
                let resource = try await TextureResource(image: image, options: .init(semantic: .color))
                screenTextures[panel] = resource
                let slot = panel == "cover" ? cover : inner
                var material = UnlitMaterial(applyPostProcessToneMap: false)
                material.color = .init(tint: .white, texture: .init(resource))
                slot.0.model!.materials[slot.1] = material
            }
            screenFrames[panel] = jpeg
        }
        let raise = Float((180 - angle) * .pi / 180)
        // Bisect the open fold so both leaves face the camera equally. Ease
        // back to a front-facing cover as it closes, without a panel-switch snap.
        let yaw = simd_quatf(angle: -min(raise, Float(angle * .pi / 180)) / 2, axis: [0, 1, 0])
        controller.time = (180 - angle) / 180 * 5
        rest.orientation = yaw * simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        wrapper.orientation = simd_quatf(angle: Float(roll * .pi / 180), axis: [0, 0, 1])
        let fold = simd_quatf(angle: raise, axis: [0, 1, 0])
        let half = flatBounds.extents.x / 2
        let points: [SIMD3<Float>] = [fold.act([-half, 0, 0]), [0, 0, 0], [half, 0, 0]]
        let xs = points.map { yaw.act($0).x }
        rest.position.x = -((xs.min() ?? 0) + (xs.max() ?? 0)) / 2
        // Advancing the paused clip's time takes an update before skinning settles.
        // Camera rotation and texture-only frames do not change skinning: one pass.
        let poseChanged = lastAngle != angle
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
        pieces = (panel == "cover" ? coverProjection : innerProjection).pieces(cameraDistance: cameraDistance, fieldOfView: fieldOfView, aspect: Float(width) / Float(height))
        // RealityRenderer outputs Display P3; sampling its sRGB Metal texture
        // yields linear values. Let Core Image convert the gamut and
        // encode to sRGB once when exporting, preserving screen colors.
        guard let rendered = CIImage(mtlTexture: texture, options: [.colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)!])?.oriented(.downMirrored),
              let cg = context.createCGImage(rendered, from: rendered.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) else { throw CocoaError(.fileReadUnknown) }
        return try FastPNG.encode(cg)
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
