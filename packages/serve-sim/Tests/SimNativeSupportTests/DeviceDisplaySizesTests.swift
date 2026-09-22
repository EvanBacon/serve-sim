import XCTest
@testable import SimNativeSupport

final class DeviceDisplaySizesTests: XCTestCase {
    func testReadsIntegratedDigitizerDisplaysAndSkipsPresentationSurfaces() throws {
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>capabilities</key>
            <dict>
                <key>displays</key>
                <array>
                    <dict>
                        <key>chromeIdentifier</key>
                        <string>com.apple.dt.devicekit.chrome.phone15</string>
                        <key>displayType</key>
                        <string>integrated</string>
                        <key>hasDigitizer</key>
                        <true/>
                        <key>height</key>
                        <integer>2034</integer>
                        <key>width</key>
                        <integer>1398</integer>
                    </dict>
                    <dict>
                        <key>chromeIdentifier</key>
                        <string>com.apple.dt.devicekit.chrome.phone14</string>
                        <key>displayType</key>
                        <string>integrated</string>
                        <key>hasDigitizer</key>
                        <true/>
                        <key>height</key>
                        <integer>2853</integer>
                        <key>width</key>
                        <integer>2007</integer>
                    </dict>
                    <dict>
                        <key>displayType</key>
                        <string>tvOut</string>
                        <key>hasDigitizer</key>
                        <false/>
                        <key>height</key>
                        <integer>480</integer>
                        <key>width</key>
                        <integer>720</integer>
                    </dict>
                    <dict>
                        <key>displayType</key>
                        <string>scene</string>
                        <key>hasDigitizer</key>
                        <true/>
                        <key>height</key>
                        <integer>4320</integer>
                        <key>width</key>
                        <integer>7680</integer>
                    </dict>
                </array>
            </dict>
        </dict>
        </plist>
        """
        let sizes = DeviceDisplaySizes.nativeSizes(
            fromCapabilitiesPlist: Data(xml.utf8)
        )
        XCTAssertEqual(sizes, [
            FramebufferSurfaceSize(width: 1398, height: 2034),
            FramebufferSurfaceSize(width: 2007, height: 2853),
        ])
    }

    func testEmptyOrMalformedPlistYieldsNoSizes() {
        XCTAssertEqual(DeviceDisplaySizes.nativeSizes(fromCapabilitiesPlist: Data()), [])
        XCTAssertEqual(
            DeviceDisplaySizes.nativeSizes(fromCapabilitiesPlist: Data("not a plist".utf8)),
            []
        )
    }
}
