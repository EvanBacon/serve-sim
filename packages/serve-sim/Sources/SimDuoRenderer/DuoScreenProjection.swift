import Foundation
import RealityKit
import simd

/// Small cached samples of each screen plane, skinned with the rendered model.
@MainActor final class DuoScreenProjection {
    private struct Sample {
        let position: SIMD3<Float>
        let uv: SIMD2<Float>
        let influences: [MeshJointInfluence]
    }
    private struct Leaf {
        let samples: [Sample]
        let region: SIMD4<Float>
    }
    private let entity: ModelEntity
    private let joints: [MeshResource.Skeleton.Joint]
    private let jointIndices: [Int?]
    private let leaves: [Leaf]

    init(slot: (ModelEntity, Int), inner: Bool) throws {
        entity = slot.0
        let contents = entity.model!.mesh.contents
        guard let part = contents.models.flatMap({ Array($0.parts) }).first(where: { $0.materialIndex == slot.1 }),
              let coordinates = part.textureCoordinates,
              let skeletonID = part.skeletonID, let skeleton = contents.skeletons[skeletonID],
              let influences = part.jointInfluences else { throw CocoaError(.fileReadCorruptFile) }
        joints = skeleton.joints
        jointIndices = skeleton.joints.map { slot.0.jointNames.firstIndex(of: $0.name) }
        let positions = Array(part.positions.elements), uvs = Array(coordinates.elements)
        let weights = Array(influences.influences.elements)
        let count = weights.count / positions.count
        let samples = positions.indices.map { index in
            Sample(position: positions[index], uv: SIMD2(uvs[index].x, 1 - uvs[index].y), influences: Array(weights[(index * count)..<((index + 1) * count)]))
        }
        let regions: [SIMD4<Float>] = inner ? [SIMD4(0, 0.5, 1, 0.5), SIMD4(0, 0, 1, 0.5)] : [SIMD4(0, 0, 1, 1)]
        leaves = try regions.map { region in
            let candidates = inner ? samples.filter { $0.uv.y > region.y + 0.02 && $0.uv.y < region.y + region.w - 0.02 } : samples
            let targets = [SIMD2<Float>(0.15, 0.2), SIMD2<Float>(0.85, 0.2), SIMD2<Float>(0.15, 0.8)]
            let selected = targets.compactMap { target in
                let uv = SIMD2(target.x, region.y + target.y * region.w)
                return candidates.min { simd_distance_squared($0.uv, uv) < simd_distance_squared($1.uv, uv) }
            }
            guard selected.count == 3 else { throw CocoaError(.fileReadCorruptFile) }
            let u = selected[1].uv - selected[0].uv, v = selected[2].uv - selected[0].uv
            guard abs(u.x * v.y - u.y * v.x) > 0.000001 else { throw CocoaError(.fileReadCorruptFile) }
            return Leaf(samples: selected, region: region)
        }
    }

    func pieces(cameraDistance: Float, fieldOfView: Float, aspect: Float) -> [[[Double]]] {
        let transforms = entity.jointTransforms
        var global = [simd_float4x4](repeating: matrix_identity_float4x4, count: joints.count)
        for index in joints.indices {
            let local = jointIndices[index].flatMap { $0 < transforms.count ? transforms[$0].matrix : nil } ?? joints[index].restPoseTransform.matrix
            global[index] = joints[index].parentIndex.map { global[$0] * local } ?? local
        }
        let skin = joints.indices.map { global[$0] * joints[$0].inverseBindPoseMatrix }
        let world = entity.transformMatrix(relativeTo: nil)
        func position(_ sample: Sample) -> SIMD3<Float> {
            var point = SIMD4<Float>(repeating: 0)
            for influence in sample.influences where influence.weight > 0 {
                point += (skin[influence.jointIndex] * SIMD4(sample.position, 1)) * influence.weight
            }
            let p = world * point
            return SIMD3(p.x, p.y, p.z)
        }
        let scale: Float = 1 / tan(fieldOfView * .pi / 360)
        return leaves.map { leaf in
            let s = leaf.samples, a = position(s[0]), b = position(s[1]), c = position(s[2])
            let u = s[1].uv - s[0].uv, v = s[2].uv - s[0].uv
            let determinant = u.x * v.y - u.y * v.x
            func project(_ uv: SIMD2<Float>) -> [Double] {
                let delta = uv - s[0].uv
                let point = a + (b - a) * ((delta.x * v.y - delta.y * v.x) / determinant) + (c - a) * ((u.x * delta.y - u.y * delta.x) / determinant)
                let depth = max(0.001, cameraDistance - point.z)
                return [Double(0.5 + point.x * scale / depth / aspect / 2), Double(0.5 - point.y * scale / depth / 2)]
            }
            let r = leaf.region
            return [project(SIMD2(r.x, r.y)), project(SIMD2(r.x + r.z, r.y)), project(SIMD2(r.x + r.z, r.y + r.w)), project(SIMD2(r.x, r.y + r.w)), [Double(r.x), Double(r.y), Double(r.z), Double(r.w)]]
        }
    }
}
