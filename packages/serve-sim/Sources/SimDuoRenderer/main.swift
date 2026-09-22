import Foundation

private struct Request: Decodable, Sendable {
    let jpegLength: Int
    let panel: String
    let hingeDegrees: Double
    let rollDegrees: Double
    let fullResolution: Bool?
}

private func readExact(_ count: Int) throws -> Data? {
    var result = Data()
    while result.count < count {
        guard let bytes = try FileHandle.standardInput.read(upToCount: count - result.count), !bytes.isEmpty else {
            if result.isEmpty { return nil }
            throw CocoaError(.fileReadCorruptFile)
        }
        result.append(bytes)
    }
    return result
}

private func readRequest() throws -> (Request, Data)? {
    guard let prefix = try readExact(4) else { return nil }
    let length = prefix.reduce(0) { ($0 << 8) | Int($1) }
    guard (1...4096).contains(length), let header = try readExact(length) else { throw CocoaError(.fileReadCorruptFile) }
    let request = try JSONDecoder().decode(Request.self, from: header)
    guard (1...32_000_000).contains(request.jpegLength), ["cover", "inner"].contains(request.panel),
          let jpeg = try readExact(request.jpegLength) else { throw CocoaError(.fileReadCorruptFile) }
    return (request, jpeg)
}

@main struct Main {
    @MainActor static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw CocoaError(.fileReadInvalidFileName) }
            let renderer = try await DuoRenderer(modelURL: URL(fileURLWithPath: CommandLine.arguments[1]))
            while let (request, jpeg) = try await Task.detached(operation: { try readRequest() }).value {
                let rendered = try await renderer.render(jpeg: jpeg, panel: request.panel, angle: request.hingeDegrees, roll: request.rollDegrees, fullResolution: request.fullResolution ?? true)
                let header = try JSONSerialization.data(withJSONObject: [
                    "jpegLength": rendered.count, "width": renderer.width, "height": renderer.height,
                    "pieces": renderer.pieces, "panel": request.panel, "hingeDegrees": request.hingeDegrees,
                ])
                var length = UInt32(header.count).bigEndian
                try FileHandle.standardOutput.write(contentsOf: Data(bytes: &length, count: 4))
                try FileHandle.standardOutput.write(contentsOf: header)
                try FileHandle.standardOutput.write(contentsOf: rendered)
            }
        } catch {
            fputs("[duo-renderer] \(error)\n", stderr)
            exit(1)
        }
    }
}
