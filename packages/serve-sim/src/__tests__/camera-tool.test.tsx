import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CameraStatusPill,
  CameraTestPatternHint,
  CameraMediaPreview,
  CameraInlineBanner,
  CAMERA_HEIC_ERROR,
  CAMERA_LARGE_VIDEO_BYTES,
  CAMERA_LARGE_VIDEO_WARNING,
  CAMERA_POLL_INTERVAL_MS,
  cameraSourceErrorMessage,
  isHeicLikeFile,
  isOversizedCameraVideo,
  nextCameraPillState,
  parseWebcamListOutput,
  selectCameraPrimaryKind,
} from "../client/components/camera-tool";

describe("nextCameraPillState", () => {
  test("ready stays ready on dead poll", () => {
    expect(nextCameraPillState("ready", false)).toBe("ready");
  });
  test("ready becomes active when poll says alive", () => {
    expect(nextCameraPillState("ready", true)).toBe("active");
  });
  test("active degrades to disconnected on first dead poll", () => {
    expect(nextCameraPillState("active", false)).toBe("disconnected");
  });
  test("active stays active when poll says alive", () => {
    expect(nextCameraPillState("active", true)).toBe("active");
  });
  test("disconnected drops to ready on second consecutive dead poll", () => {
    expect(nextCameraPillState("disconnected", false)).toBe("ready");
  });
  test("disconnected recovers to active if poll says alive again", () => {
    expect(nextCameraPillState("disconnected", true)).toBe("active");
  });
});

describe("selectCameraPrimaryKind", () => {
  test("no foreground bundle, helper not alive: Play", () => {
    expect(selectCameraPrimaryKind({
      bundleId: null,
      injected: false,
      source: "placeholder",
      foregroundIsInjected: false,
    })).toBe("play");
  });

  test("foreground bundle, helper not alive: Play", () => {
    expect(selectCameraPrimaryKind({
      bundleId: "com.example.app",
      injected: false,
      source: "webcam",
      foregroundIsInjected: false,
    })).toBe("play");
  });

  test("helper alive but no real source picked: Play (not Stop)", () => {
    expect(selectCameraPrimaryKind({
      bundleId: "com.example.app",
      injected: true,
      source: "placeholder",
      foregroundIsInjected: true,
    })).toBe("play");
  });

  test("helper alive with real source, foreground app not yet injected: Inject", () => {
    expect(selectCameraPrimaryKind({
      bundleId: "com.example.app",
      injected: true,
      source: "webcam",
      foregroundIsInjected: false,
    })).toBe("attach");
  });

  test("helper alive with real source, foreground app injected: Stop", () => {
    expect(selectCameraPrimaryKind({
      bundleId: "com.example.app",
      injected: true,
      source: "webcam",
      foregroundIsInjected: true,
    })).toBe("stop");
  });

  test("page reload mid-injection (helper alive, real source, bundle not yet detected): Stop", () => {
    expect(selectCameraPrimaryKind({
      bundleId: null,
      injected: true,
      source: "webcam",
      foregroundIsInjected: false,
    })).toBe("stop");
  });

  test("image source counts as a real source", () => {
    expect(selectCameraPrimaryKind({
      bundleId: "com.example.app",
      injected: true,
      source: "image",
      foregroundIsInjected: true,
    })).toBe("stop");
  });

  test("video source counts as a real source", () => {
    expect(selectCameraPrimaryKind({
      bundleId: "com.example.app",
      injected: true,
      source: "video",
      foregroundIsInjected: true,
    })).toBe("stop");
  });
});

describe("parseWebcamListOutput", () => {
  test("returns empty list for empty stdout", () => {
    expect(parseWebcamListOutput("")).toEqual([]);
  });

  test("parses id\\tname rows from the helper", () => {
    const stdout = [
      "FA-CAM-1\tC505 HD Webcam",
      "BUILT-IN-001\tMacBook Pro Camera",
    ].join("\n");
    expect(parseWebcamListOutput(stdout)).toEqual([
      { id: "FA-CAM-1", name: "C505 HD Webcam" },
      { id: "BUILT-IN-001", name: "MacBook Pro Camera" },
    ]);
  });

  test("ignores build noise interleaved with camera rows", () => {
    const stdout = [
      "Built: /tmp/serve-sim-camera-helper",
      "/tmp/serve-sim-camera-helper: Mach-O universal binary with 2 architectures",
      "Mach-O 64-bit executable x86_64",
      "Mach-O 64-bit executable arm64",
      "FA-CAM-1\tC505 HD Webcam",
      "BUILT-IN-001\tMacBook Pro Camera",
    ].join("\n");
    expect(parseWebcamListOutput(stdout)).toEqual([
      { id: "FA-CAM-1", name: "C505 HD Webcam" },
      { id: "BUILT-IN-001", name: "MacBook Pro Camera" },
    ]);
  });

  test("drops malformed rows with empty id or name", () => {
    const stdout = [
      "\tname-only",
      "id-only\t",
      "good\tCamera",
    ].join("\n");
    expect(parseWebcamListOutput(stdout)).toEqual([
      { id: "good", name: "Camera" },
    ]);
  });
});

describe("isOversizedCameraVideo", () => {
  test("flags videos above 200MB", () => {
    expect(isOversizedCameraVideo({ type: "video/mp4", size: CAMERA_LARGE_VIDEO_BYTES + 1 })).toBe(true);
  });
  test("ignores videos at exactly 200MB (must exceed)", () => {
    expect(isOversizedCameraVideo({ type: "video/mp4", size: CAMERA_LARGE_VIDEO_BYTES })).toBe(false);
  });
  test("ignores small videos", () => {
    expect(isOversizedCameraVideo({ type: "video/mp4", size: 10 * 1024 * 1024 })).toBe(false);
  });
  test("ignores large images", () => {
    expect(isOversizedCameraVideo({ type: "image/jpeg", size: CAMERA_LARGE_VIDEO_BYTES + 1 })).toBe(false);
  });
  test("falls back to extension for videos with missing mime", () => {
    expect(isOversizedCameraVideo({ type: "", name: "clip.mov", size: CAMERA_LARGE_VIDEO_BYTES + 1 })).toBe(true);
  });
});

describe("isHeicLikeFile", () => {
  test("detects image/heic mime", () => {
    expect(isHeicLikeFile({ type: "image/heic", name: "x" })).toBe(true);
  });
  test("detects image/heif mime", () => {
    expect(isHeicLikeFile({ type: "image/heif", name: "x" })).toBe(true);
  });
  test("detects .heic extension when mime is empty", () => {
    expect(isHeicLikeFile({ type: "", name: "photo.HEIC" })).toBe(true);
  });
  test("detects .heif extension when mime is empty", () => {
    expect(isHeicLikeFile({ type: "", name: "photo.heif" })).toBe(true);
  });
  test("ignores jpeg", () => {
    expect(isHeicLikeFile({ type: "image/jpeg", name: "photo.jpg" })).toBe(false);
  });
});

describe("cameraSourceErrorMessage", () => {
  test("maps HEIC image failures to actionable copy", () => {
    expect(cameraSourceErrorMessage({
      rawMessage: "could not decode image",
      lastFileIsHeic: true,
      source: "image",
    })).toBe(CAMERA_HEIC_ERROR);
  });

  test("maps HEIC video/file failures while source is video", () => {
    expect(cameraSourceErrorMessage({
      rawMessage: "reader failed",
      lastFileIsHeic: true,
      source: "video",
    })).toBe(CAMERA_HEIC_ERROR);
  });

  test("preserves non-HEIC file errors", () => {
    expect(cameraSourceErrorMessage({
      rawMessage: "reader failed",
      lastFileIsHeic: false,
      source: "video",
    })).toBe("reader failed");
  });

  test("does not rewrite webcam errors with stale HEIC state", () => {
    expect(cameraSourceErrorMessage({
      rawMessage: "no matching camera",
      lastFileIsHeic: true,
      source: "webcam",
    })).toBe("no matching camera");
  });

  test("does not rewrite placeholder errors with stale HEIC state", () => {
    expect(cameraSourceErrorMessage({
      rawMessage: "helper stopped",
      lastFileIsHeic: true,
      source: "placeholder",
    })).toBe("helper stopped");
  });
});

describe("CAMERA_POLL_INTERVAL_MS", () => {
  test("falls in the requested 2–5s window", () => {
    expect(CAMERA_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
    expect(CAMERA_POLL_INTERVAL_MS).toBeLessThanOrEqual(5000);
  });
});

describe("CameraStatusPill — UI state matrix", () => {
  test("Ready state renders label 'Ready'", () => {
    const html = renderToStaticMarkup(<CameraStatusPill state="ready" />);
    expect(html).toContain("Ready");
    expect(html).not.toContain("Active");
    expect(html).not.toContain("Disconnected");
  });

  test("Active state renders 'Active' label and live indicator", () => {
    const html = renderToStaticMarkup(<CameraStatusPill state="active" />);
    expect(html).toContain("Active");
    expect(html).not.toContain("Ready");
    expect(html).toContain("rounded-full");
  });

  test("Disconnected state renders 'Disconnected' and a non-success dot", () => {
    const html = renderToStaticMarkup(<CameraStatusPill state="disconnected" />);
    expect(html).toContain("Disconnected");
    expect(html).not.toContain("Active");
  });
});

describe("CameraTestPatternHint (placeholder state, no source)", () => {
  test("renders a visible 'Test-pattern feed' label", () => {
    const html = renderToStaticMarkup(<CameraTestPatternHint />);
    expect(html).toContain("Test-pattern feed");
  });

  test("uses subdued typography without low-opacity icons (text-only label)", () => {
    const html = renderToStaticMarkup(<CameraTestPatternHint />);
    expect(html).not.toContain("<svg");
  });
});

describe("CameraMediaPreview — source states", () => {
  test("placeholder mode shows 'Select or drop media' invitation", () => {
    const html = renderToStaticMarkup(
      <CameraMediaPreview mode="placeholder" fileName={null} webcamName={null} sourceKind="placeholder" />,
    );
    expect(html).toContain("Select or drop media");
  });

  test("image source shows the dropped file name and Image badge", () => {
    const html = renderToStaticMarkup(
      <CameraMediaPreview mode="file" fileName="hero.jpg" webcamName={null} sourceKind="image" />,
    );
    expect(html).toContain("hero.jpg");
    expect(html).toContain("Image");
  });

  test("video source shows the dropped file name and Video badge", () => {
    const html = renderToStaticMarkup(
      <CameraMediaPreview mode="file" fileName="reel.mp4" webcamName={null} sourceKind="video" />,
    );
    expect(html).toContain("reel.mp4");
    expect(html).toContain("Video");
  });

  test("webcam source shows the webcam name and Webcam badge", () => {
    const html = renderToStaticMarkup(
      <CameraMediaPreview mode="webcam" fileName={null} webcamName="MacBook Pro Camera" sourceKind="webcam" />,
    );
    expect(html).toContain("MacBook Pro Camera");
    expect(html).toContain("Webcam");
  });
});

describe("CameraInlineBanner — error / warning UI", () => {
  test("danger banner renders the message and uses the danger token", () => {
    const html = renderToStaticMarkup(
      <CameraInlineBanner kind="error" message="helper crashed" />,
    );
    expect(html).toContain("helper crashed");
    expect(html).toContain("danger");
  });

  test("warning banner surfaces the large-video copy verbatim", () => {
    const html = renderToStaticMarkup(
      <CameraInlineBanner kind="warning" message={CAMERA_LARGE_VIDEO_WARNING} />,
    );
    expect(CAMERA_LARGE_VIDEO_WARNING).toContain(">200 MB");
    expect(html).toContain("Large video");
    expect(html).toContain("may stutter on shared memory");
  });

  test("HEIC error message reads as the actionable copy", () => {
    expect(CAMERA_HEIC_ERROR).toContain("HEIC decode failed");
    expect(CAMERA_HEIC_ERROR).toContain("JPEG");
    expect(CAMERA_HEIC_ERROR).toContain("PNG");
  });
});
