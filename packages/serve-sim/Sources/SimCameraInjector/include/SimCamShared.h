// Shared memory wire format for serve-sim's simulator camera feed.
//
// One process (the host helper, running on macOS) captures webcam frames and
// writes them into a POSIX shared-memory region. The injected dylib inside
// the simulator app maps the same region and dispatches the latest frame to
// AVFoundation delegates / preview layers.
//
// Format: BGRA, top-down, no padding except whatever bytesPerRow says.
//
// Synchronization is intentionally lock-free and lossy: the writer bumps
// `frameSeq` last after writing pixels; the reader samples `frameSeq` before
// and after copying and discards the read if they disagree. A single dropped
// frame is fine for a 30 fps camera.

#ifndef SIM_CAM_SHARED_H
#define SIM_CAM_SHARED_H

#include <stdint.h>

#define SIMCAM_SHM_MAGIC      0x53434D31u  // 'SCM1'
#define SIMCAM_PIXEL_BGRA     0u
#define SIMCAM_DEFAULT_WIDTH  1280u
#define SIMCAM_DEFAULT_HEIGHT 720u

// Mirror mode codes for SimCamShmHeader.mirrorMode.
// "Unset" lets the dylib fall back to its env-var configuration (back-compat
// with hosts that don't write the byte).
#define SIMCAM_MIRROR_UNSET   0xFF
#define SIMCAM_MIRROR_AUTO    0
#define SIMCAM_MIRROR_ON      1
#define SIMCAM_MIRROR_OFF     2

// Header is 64 bytes — keeps pixel data 16-byte aligned.
typedef struct __attribute__((packed)) {
    uint32_t magic;        // SIMCAM_SHM_MAGIC
    uint32_t version;      // bumps on layout change
    uint32_t width;
    uint32_t height;
    uint32_t pixelFormat;  // SIMCAM_PIXEL_BGRA
    uint32_t bytesPerRow;
    uint64_t pixelByteSize;
    uint64_t frameSeq;     // written LAST; readers check tearing via re-read
    uint64_t timestampNs;  // mach_absolute_time-based, host monotonic
    uint8_t  mirrorMode;   // SIMCAM_MIRROR_*; UNSET = ignore (use env)
    uint8_t  reserved[15];
} SimCamShmHeader;

_Static_assert(sizeof(SimCamShmHeader) == 64, "SimCamShmHeader must be 64 bytes");

// Total shm size for given dimensions: header + width*height*4
static inline uint64_t SimCamShmSizeFor(uint32_t w, uint32_t h) {
    return (uint64_t)sizeof(SimCamShmHeader) + (uint64_t)w * (uint64_t)h * 4ull;
}

#endif
