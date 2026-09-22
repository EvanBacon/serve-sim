import AppKit
import RealityKit

/// Device Hub's neutral V68 shell palette, inspected in Xcode 27.1's
/// CoreDevicePopDeviceKitExtension (material table at 0xaca08, factory 0xadf28).
/// These overrides leave the two live display materials untouched.
@MainActor enum DuoShellMaterials {
    private struct Finish {
        let color: SIMD3<Double>
        var lit = true
        var roughness: Float = 1
        var metallic: Float = 1
        var specular: Float = 0.5
        var opacity: Float = 1

        func material() -> any Material {
            let tint = NSColor(srgbRed: color.x, green: color.y, blue: color.z, alpha: 1)
            if !lit {
                return UnlitMaterial(color: tint)
            }
            var material = PhysicallyBasedMaterial()
            material.baseColor = .init(tint: tint)
            material.roughness = .init(floatLiteral: roughness)
            material.metallic = .init(floatLiteral: metallic)
            material.specular = .init(floatLiteral: specular)
            material.clearcoat = 0.0
            material.clearcoatRoughness = 0.0
            if opacity < 1 { material.blending = .transparent(opacity: .init(floatLiteral: opacity)) }
            return material
        }
    }

    private static let finishes: [String: Finish] = [
        "BpyJHmntcFyNbpi": .init(color: [0.570458651, 0.570472360, 0.570464909]),
        "DalMywJTbMzKHhJ": .init(color: [0.475634933, 0.475646734, 0.475640416]),
        "HCGQGgQPyxtjDwz": .init(color: [0.000000000, 0.000000000, 0.000000000], roughness: 0.5, metallic: 0),
        "HtHHabetaCtVdYj": .init(color: [0.370555162, 0.370564580, 0.370559573], lit: false, roughness: 0.5, metallic: 0),
        "KQflzzRyzmDVLKR": .init(color: [0.000000000, 0.000000000, 0.000000000], lit: false, roughness: 0.5, metallic: 0),
        "NgeeybQSjqpuSBr": .init(color: [0.574148536, 0.574162424, 0.574154973]),
        "PLzJQjJEDhjIwvC": .init(color: [0.000000000, 0.000000000, 0.000000000], lit: false, roughness: 0.5, metallic: 0),
        "TzYENmopFAzWHxj": .init(color: [0.000000000, 0.000000000, 0.000000000], lit: false, roughness: 0.5, metallic: 0),
        "UzUzwPKtObjRjQN": .init(color: [0.754068851, 0.754086852, 0.754077196], specular: 0),
        "angCfuidNsLdRXd": .init(color: [0.570458651, 0.570472360, 0.570464909], specular: 0),
        "cVTxCUWyGoaEFOH": .init(color: [0.000000000, 0.000000000, 0.000000000], lit: false),
        "cbPOUScIEwDvetK": .init(color: [0.574148536, 0.574162424, 0.574155033]),
        "koAgRGAzVMlaxZO": .init(color: [0.570458651, 0.570472360, 0.570464909], specular: 0),
        "mcThCvSMUbymmZu": .init(color: [0.574148536, 0.574162424, 0.574155033]),
        "oDtAtvTEJpneDvo": .init(color: [0.570458651, 0.570472360, 0.570464909], roughness: 0.5, metallic: 0, opacity: 0),
        "tDyevDmZRbbFVYk": .init(color: [0.570458651, 0.570472360, 0.570464909]),
        "vRKRfcmuxoTczcH": .init(color: [0.570458651, 0.570472360, 0.570464909], specular: 0),
        "wNuugqgtovLtQlc": .init(color: [0.000000000, 0.000000000, 0.000000000]),
        "zQbRMtkwMXgbghg": .init(color: [0.000000000, 0.000000000, 0.000000000], opacity: 0),
    ]

    static func apply(to entity: Entity) {
        if let model = entity as? ModelEntity, var component = model.model {
            component.materials = component.materials.map { material in
                guard let name = material.name, let finish = finishes[name] else { return material }
                return finish.material()
            }
            model.model = component
        }
        for child in entity.children { apply(to: child) }
    }
}

// Device Hub calls the same RealityKit object-lighting entry point. Declaring it
// as a static method preserves its Swift metatype calling convention.
extension EnvironmentResource {
    @_silgen_name("$s10RealityKit19EnvironmentResourceC13defaultObjectACyFZ")
    static func duoObjectLighting() -> EnvironmentResource
}
