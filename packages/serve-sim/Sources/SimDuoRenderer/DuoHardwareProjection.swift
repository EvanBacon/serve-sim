import Foundation
import RealityKit
import simd

/// Authored button centers, attached to the same animated bones as their meshes.
@MainActor final class DuoHardwareProjection {
    private struct Button {
        let center: SIMD3<Float>
        let tangent: SIMD3<Float>
        let joint: Int
    }
    private let entity: ModelEntity
    private let joints: [MeshResource.Skeleton.Joint]
    private let jointIndices: [Int?]
    private let buttons: [Button]

    init(entity: ModelEntity) throws {
        self.entity = entity
        let contents = entity.model!.mesh.contents
        let parts = contents.models.flatMap { Array($0.parts) }
        // V68's volume down/up, power, and camera-control meshes.
        let ids = ["CmYdOlPKmuMDoXR", "koDLxoGBdfDshrV", "eMjBYLfkSbgWYfC", "OLwRWbIGbztiQrw"]
        guard let first = parts.first(where: { $0.id == ids[0] }),
              let skeletonID = first.skeletonID, let skeleton = contents.skeletons[skeletonID] else { throw CocoaError(.fileReadCorruptFile) }
        joints = skeleton.joints
        jointIndices = joints.map { entity.jointNames.firstIndex(of: $0.name) }
        buttons = try ids.enumerated().map { index, id in
            guard let part = parts.first(where: { $0.id == id }), part.skeletonID == skeletonID,
                  let influences = part.jointInfluences else { throw CocoaError(.fileReadCorruptFile) }
            let weights = Array(influences.influences.elements).filter { $0.weight > 0 }
            guard let joint = weights.first?.jointIndex,
                  weights.allSatisfy({ $0.jointIndex == joint && $0.weight == 1 }) else { throw CocoaError(.fileReadCorruptFile) }
            var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
            for point in part.positions.elements { lo = simd_min(lo, point); hi = simd_max(hi, point) }
            return Button(center: (lo + hi) / 2, tangent: index < 2 ? SIMD3(1, 0, 0) : SIMD3(0, 0, 1), joint: joint)
        }
    }

    func project(cameraDistance: Float, fieldOfView: Float, aspect: Float) -> [[String: Double]] {
        let transforms = entity.jointTransforms
        var global = [simd_float4x4](repeating: matrix_identity_float4x4, count: joints.count)
        for index in joints.indices {
            let local = jointIndices[index].flatMap { $0 < transforms.count ? transforms[$0].matrix : nil } ?? joints[index].restPoseTransform.matrix
            global[index] = joints[index].parentIndex.map { global[$0] * local } ?? local
        }
        let world = entity.transformMatrix(relativeTo: nil)
        let scale: Float = 1 / tan(fieldOfView * .pi / 360)
        return buttons.map { button in
            let matrix = world * global[button.joint] * joints[button.joint].inverseBindPoseMatrix
            func project(_ point: SIMD3<Float>) -> SIMD2<Float> {
                let p = matrix * SIMD4(point, 1)
                let depth = max(0.001, cameraDistance - p.z)
                return SIMD2(0.5 + p.x * scale / depth / aspect / 2, 0.5 - p.y * scale / depth / 2)
            }
            let center = project(button.center)
            let delta = project(button.center + button.tangent) - center
            return ["x": Double(center.x), "y": Double(center.y), "angle": Double(atan2(delta.y, delta.x * aspect) * 180 / .pi)]
        }
    }
}
