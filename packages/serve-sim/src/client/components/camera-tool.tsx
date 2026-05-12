import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Chevron, PlayGlyph, StopGlyph, ReloadIcon } from "../icons";
import { execOnHost, shellEscape } from "../utils/exec";
import { fileExtension, uploadFileToTmp } from "../utils/drop";

type CamSource = "placeholder" | "image" | "video" | "webcam";
type CamMirror = "auto" | "on" | "off";
interface CamWebcam { id: string; name: string }

export type CameraPillState = "ready" | "active" | "disconnected";

export const CAMERA_POLL_INTERVAL_MS = 3000;

export const CAMERA_LARGE_VIDEO_BYTES = 200 * 1024 * 1024;
export const CAMERA_LARGE_VIDEO_WARNING =
  "Large video (>200 MB) — may stutter on shared memory";
export const CAMERA_HEIC_ERROR =
  "HEIC decode failed — export as JPEG or PNG and retry";

export function nextCameraPillState(
  current: CameraPillState,
  pollAlive: boolean,
): CameraPillState {
  if (pollAlive) return "active";
  if (current === "active") return "disconnected";
  if (current === "disconnected") return "ready";
  return current;
}

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "qt", "avi", "mkv", "webm", "mpg", "mpeg", "3gp", "3g2", "ts", "wmv",
]);

function isVideoFile(file: { type?: string; name?: string }): boolean {
  if (file.type && file.type.startsWith("video/")) return true;
  const name = (file.name ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(dot + 1));
}

export function isOversizedCameraVideo(file: {
  type?: string;
  name?: string;
  size: number;
}): boolean {
  return isVideoFile(file) && file.size > CAMERA_LARGE_VIDEO_BYTES;
}

export function isHeicLikeName(input: { type?: string; name?: string }): boolean {
  const type = (input.type ?? "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  const name = (input.name ?? "").toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

export function CameraStatusPill({ state }: { state: CameraPillState }) {
  const label =
    state === "active" ? "Active" : state === "disconnected" ? "Disconnected" : "Ready";
  const dotClass =
    state === "active"
      ? "size-1.5 rounded-full bg-success-emerald [box-shadow:0_0_6px_rgba(74,222,128,0.7)]"
      : state === "disconnected"
        ? "size-1.5 rounded-full bg-danger-soft [box-shadow:0_0_6px_rgba(248,113,113,0.55)]"
        : null;
  return (
    <span
      className="text-[11px] text-white/55 font-mono inline-flex items-center gap-1.5 justify-self-end leading-none"
      data-camera-pill-state={state}
    >
      {dotClass && <span className={dotClass} />}
      {label}
    </span>
  );
}

export function CameraTestPatternHint() {
  return (
    <p
      className="m-0 text-center text-[10px] leading-[1.5] text-white/45"
      data-camera-test-pattern-hint
    >
      Test-pattern feed
    </p>
  );
}

interface CameraMediaPreviewProps {
  mode: "placeholder" | "file" | "webcam" | "uploading";
  fileName: string | null;
  webcamName: string | null;
  sourceKind: CamSource;
}

export function CameraMediaPreview({
  mode,
  fileName,
  webcamName,
  sourceKind,
}: CameraMediaPreviewProps) {
  if (mode === "uploading") {
    return <span className="text-[11px] text-white/55">Uploading…</span>;
  }
  if (mode === "file") {
    return (
      <>
        <div className="shrink-0 text-[9px] tracking-[0.1em] uppercase text-white/55 bg-white/[0.06] border border-white/8 px-[7px] py-[2px] rounded-full">
          {sourceKind === "video" ? "Video" : "Image"}
        </div>
        <span className="flex-1 min-w-0 truncate text-[12px] text-white/90 font-mono">
          {fileName ?? ""}
        </span>
      </>
    );
  }
  if (mode === "webcam") {
    return (
      <>
        <div className="shrink-0 text-[9px] tracking-[0.1em] uppercase text-white/55 bg-white/[0.06] border border-white/8 px-[7px] py-[2px] rounded-full">
          Webcam
        </div>
        <span className="flex-1 min-w-0 truncate text-[12px] text-white/90 font-mono">
          {webcamName ?? ""}
        </span>
      </>
    );
  }
  return <span className="text-[12px] text-white/85 font-medium">Select or drop media</span>;
}

export function CameraInlineBanner({
  kind,
  message,
}: {
  kind: "error" | "warning";
  message: string;
}) {
  const classes =
    kind === "warning"
      ? "bg-warning/10 border border-warning/25 text-warning-soft text-[11px] px-2 py-1.5 rounded-md break-words"
      : "bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md break-words";
  return (
    <div className={classes} data-camera-banner-kind={kind} role={kind === "error" ? "alert" : "status"}>
      {message}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function CameraTool({
  udid,
  bundleId,
}: {
  udid: string;
  bundleId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<CamSource>("placeholder");
  const [filePath, setFilePath] = useState<string>("");
  const [droppedFileName, setDroppedFileName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [webcams, setWebcams] = useState<CamWebcam[]>([]);
  const [webcamLoading, setWebcamLoading] = useState(false);
  const [webcamId, setWebcamId] = useState<string>("");
  const [mirror, setMirror] = useState<CamMirror>("auto");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [, setStatus] = useState<string | null>(null);
  const [injected, setInjected] = useState(false);
  const [pillState, setPillState] = useState<CameraPillState>("ready");
  const [injectedBundleIds, setInjectedBundleIds] = useState<Set<string>>(() => new Set());
  const lastFileIsHeicRef = useRef(false);
  const skipNextAutoSwapRef = useRef(false);
  const skipNextAutoMirrorRef = useRef(false);

  const cliPrefix = useMemo(() => {
    const bin = window.__SIM_PREVIEW__?.serveSimBin;
    if (!bin) return "serve-sim";
    if (/\.ts$/.test(bin)) return `bun ${shellEscape(bin)}`;
    if (/\.js$/.test(bin)) return `node ${shellEscape(bin)}`;
    return shellEscape(bin);
  }, []);

  const fetchCameraStatus = useCallback(async () => {
    const res = await execOnHost(`${cliPrefix} camera status -d ${udid}`);
    if (res.exitCode !== 0) return null;
    try {
      return JSON.parse(res.stdout.trim()) as {
        alive?: boolean;
        source?: string;
        arg?: string;
        mirror?: string;
        helperPid?: number;
      };
    } catch {
      return null;
    }
  }, [cliPrefix, udid]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const reply = await fetchCameraStatus();
      if (cancelled || !reply) return;
      if (!reply.alive) return;
      skipNextAutoSwapRef.current = true;
      skipNextAutoMirrorRef.current = true;
      if (reply.source === "placeholder" || reply.source === "webcam" || reply.source === "image" || reply.source === "video") {
        setSource(reply.source);
      }
      if ((reply.source === "image" || reply.source === "video") && reply.arg) {
        setFilePath(reply.arg);
        setDroppedFileName(reply.arg.split("/").pop() ?? null);
      }
      if (reply.source === "webcam" && reply.arg) setWebcamId(reply.arg);
      if (reply.mirror === "auto" || reply.mirror === "on" || reply.mirror === "off") {
        setMirror(reply.mirror);
      }
      setInjected(true);
      setPillState("active");
      setStatus(`Reattached → ${reply.source ?? "running helper"}${reply.arg ? ` (${reply.arg})` : ""}`);
    })();
    return () => { cancelled = true; };
  }, [udid, fetchCameraStatus]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const reply = await fetchCameraStatus();
        if (cancelled) return;
        const alive = !!reply?.alive;
        setPillState((prev) => nextCameraPillState(prev, alive));
        if (!alive) {
          // Helper is gone — make sure subsequent injection takes the cold
          // path and the source menu treats "Play" as a fresh launch.
          setInjected((prevInjected) => {
            if (!prevInjected) return prevInjected;
            setInjectedBundleIds(new Set());
            return false;
          });
        }
      } finally {
        inFlight = false;
      }
    };

    timer = setInterval(() => { void tick(); }, CAMERA_POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [fetchCameraStatus]);

  const refreshWebcams = useCallback(async () => {
    setWebcamLoading(true);
    setError(null);
    try {
      const res = await execOnHost(`${cliPrefix} camera --list-webcams`);
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `--list-webcams failed (${res.exitCode})`);
        return;
      }
      const list: CamWebcam[] = res.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          if (tab < 0) return { id: line, name: line };
          return { id: line.slice(0, tab), name: line.slice(tab + 1) };
        });
      setWebcams(list);
      if (list.length > 0 && !webcamId) setWebcamId(list[0]!.id);
    } finally {
      setWebcamLoading(false);
    }
  }, [webcamId, cliPrefix]);

  useEffect(() => {
    if (sourceMenuOpen && webcams.length === 0 && !webcamLoading) {
      void refreshWebcams();
    }
  }, [sourceMenuOpen, webcams.length, webcamLoading, refreshWebcams]);

  const reportSourceError = useCallback((rawMessage: string) => {
    if (lastFileIsHeicRef.current && (source === "image" || source === "video")) {
      setError(CAMERA_HEIC_ERROR);
      return;
    }
    setError(rawMessage);
  }, [source]);

  const pushSwitch = useCallback(async (
    nextSource: CamSource,
    nextWebcamId: string,
    nextFilePath: string,
  ): Promise<boolean> => {
    const isFile = nextSource === "image" || nextSource === "video";
    const argv = ["camera", "switch", isFile ? "file" : nextSource];
    if (nextSource === "webcam" && nextWebcamId) argv.push(shellEscape(nextWebcamId));
    if (isFile) {
      if (!nextFilePath.trim()) {
        setError("Drop a file into the panel or pick another source.");
        return false;
      }
      argv.push(shellEscape(nextFilePath.trim()));
    }
    argv.push("-d", udid, "--quiet");
    const res = await execOnHost(`${cliPrefix} ${argv.join(" ")}`);
    if (res.exitCode !== 0) {
      reportSourceError(res.stderr.trim() || res.stdout.trim() || `switch failed (${res.exitCode})`);
      return false;
    }
    try {
      const json = JSON.parse(res.stdout.trim()) as { source?: string; arg?: string };
      setStatus(`Switched → ${json.source ?? nextSource}${json.arg ? ` (${json.arg})` : ""}`);
    } catch {
      setStatus(`Switched → ${nextSource}`);
    }
    return true;
  }, [udid, cliPrefix, reportSourceError]);

  const inject = useCallback(async () => {
    if (!bundleId) return;
    setPending("inject");
    setError(null);
    setStatus(null);
    try {
      const flags: string[] = ["camera", shellEscape(bundleId), "-d", udid, "--quiet"];
      if (source === "image" || source === "video") {
        if (!filePath.trim()) {
          setError("Drop a file into the panel or pick another source.");
          return;
        }
        flags.push("--file", shellEscape(filePath.trim()));
      } else if (source === "webcam") {
        if (webcamId) flags.push("--webcam", shellEscape(webcamId));
        else flags.push("--webcam");
      }
      if (mirror !== "auto") flags.push(`--mirror`, mirror);
      const res = await execOnHost(`${cliPrefix} ${flags.join(" ")}`);
      if (res.exitCode !== 0) {
        reportSourceError(res.stderr.trim() || res.stdout.trim() || `inject failed (${res.exitCode})`);
        return;
      }
      try {
        const json = JSON.parse(res.stdout.trim()) as {
          source?: string; pid?: number; helperPid?: number;
          hotSwapped?: boolean; helperRelaunched?: boolean;
        };
        const verb = json.helperRelaunched === false ? "Attached" : "Injected";
        const pidStr = json.pid ? ` pid ${json.pid}` : "";
        const helper = json.helperPid ? `, helper pid ${json.helperPid}` : "";
        setStatus(`${verb} ${json.source ?? source} into ${bundleId}${pidStr}${helper}`);
      } catch {
        setStatus(res.stdout.trim() || "Injected.");
      }
      setInjected(true);
      setPillState("active");
      setInjectedBundleIds((prev) => prev.has(bundleId) ? prev : new Set(prev).add(bundleId));
    } finally {
      setPending(null);
    }
  }, [bundleId, udid, source, filePath, webcamId, mirror, cliPrefix, reportSourceError]);

  const autoSwapKey = injected
    ? `${source}::${source === "webcam" ? webcamId : ""}::${source === "image" || source === "video" ? filePath : ""}`
    : null;
  useEffect(() => {
    if (!injected) return;
    if ((source === "image" || source === "video") && !filePath.trim()) return;
    if (source === "webcam" && !webcamId) return;
    if (skipNextAutoSwapRef.current) {
      skipNextAutoSwapRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      setPending("switch");
      setError(null);
      try {
        if (cancelled) return;
        await pushSwitch(source, webcamId, filePath);
      } finally {
        if (!cancelled) setPending(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSwapKey]);

  useEffect(() => {
    if (!injected) return;
    if (skipNextAutoMirrorRef.current) {
      skipNextAutoMirrorRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      setPending("mirror");
      setError(null);
      try {
        const res = await execOnHost(
          `${cliPrefix} camera mirror ${mirror} -d ${udid} --quiet`,
        );
        if (cancelled) return;
        if (res.exitCode !== 0) {
          setError(res.stderr.trim() || res.stdout.trim() || `mirror failed (${res.exitCode})`);
          return;
        }
        setStatus(`Mirror → ${mirror}`);
      } finally {
        if (!cancelled) setPending(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirror]);

  const stopHelper = useCallback(async () => {
    setPending("stop");
    setError(null);
    try {
      const res = await execOnHost(`${cliPrefix} camera --stop-webcam -d ${udid}`);
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `stop-webcam failed (${res.exitCode})`);
        return;
      }
      setStatus("Camera helper stopped.");
      setInjected(false);
      setPillState("ready");
      setInjectedBundleIds(new Set());
    } finally {
      setPending(null);
    }
  }, [udid, cliPrefix]);

  const handleSourceFile = useCallback(async (file: File) => {
    const isImage = file.type.startsWith("image/") || isHeicLikeName({ type: file.type, name: file.name });
    const isVideo = file.type.startsWith("video/") || isVideoFile({ type: file.type, name: file.name });
    if (!isImage && !isVideo) {
      setError(`Unsupported file type: ${file.type || file.name}`);
      return;
    }
    setUploading(true);
    setError(null);
    setWarning(null);
    if (isOversizedCameraVideo({ type: file.type, name: file.name, size: file.size })) {
      setWarning(CAMERA_LARGE_VIDEO_WARNING);
    }
    lastFileIsHeicRef.current = isHeicLikeName({ type: file.type, name: file.name });
    try {
      const ext = fileExtension(file);
      const tmpPath = await uploadFileToTmp(file, "serve-sim-camsrc", ext, execOnHost);
      setDroppedFileName(file.name);
      setSource(isVideo ? "video" : "image");
      setFilePath(tmpPath);
      setStatus(`Loaded ${file.name}`);
    } catch (e: any) {
      if (lastFileIsHeicRef.current) setError(CAMERA_HEIC_ERROR);
      else setError(e?.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleSourceFile(file);
  }, [handleSourceFile]);

  const clearMedia = useCallback(() => {
    setSource("placeholder");
    setFilePath("");
    setDroppedFileName(null);
    setError(null);
    setWarning(null);
    lastFileIsHeicRef.current = false;
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFilePicked = useCallback(async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) await handleSourceFile(file);
  }, [handleSourceFile]);

  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-camera-source-menu]")) return;
      setSourceMenuOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [sourceMenuOpen]);

  const AUTO_MIRROR_DISPLAY: CamMirror = "on";
  const mirrorDisplay: "on" | "off" = mirror === "auto" ? AUTO_MIRROR_DISPLAY : mirror;
  const mirrorIsManual = mirror !== "auto";
  const toggleMirror = useCallback(() => {
    setMirror((m) => {
      if (m === "auto") return AUTO_MIRROR_DISPLAY === "on" ? "off" : "on";
      return m === "on" ? "off" : "on";
    });
  }, []);
  const revertMirrorToAuto = useCallback(() => setMirror("auto"), []);

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
    if (dragCountRef.current === 1) setIsDragOver(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const foregroundInjected = !!bundleId && injectedBundleIds.has(bundleId);
  const primary: { label: string; onClick: () => void; kind: "play" | "stop" | "attach" } =
    !injected
      ? { label: pending === "inject" ? "Starting…" : "Play", onClick: inject, kind: "play" }
    : !foregroundInjected && bundleId
      ? { label: pending === "inject" ? "Injecting…" : `Inject ${bundleId}`, onClick: inject, kind: "attach" }
    : { label: pending === "stop" ? "Stopping…" : "Stop", onClick: stopHelper, kind: "stop" };
  const primaryDisabled = !bundleId || pending !== null || uploading;

  const isPlaceholder = source === "placeholder";
  const showWebcam = source === "webcam";
  const showFile = (source === "image" || source === "video") && !!droppedFileName;
  const activeWebcamName = showWebcam
    ? (webcams.find((w) => w.id === webcamId)?.name ?? webcamId ?? "Webcam")
    : null;
  const tileMode: CameraMediaPreviewProps["mode"] = uploading
    ? "uploading"
    : showFile
      ? "file"
      : showWebcam
        ? "webcam"
        : "placeholder";

  return (
    <div className="bg-panel border border-white/8 rounded-[10px] flex flex-col gap-2.5 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="lem-toggle grid [grid-template-columns:auto_1fr_auto] items-center gap-2 bg-transparent border-none text-white/90 py-2.5 px-1 -my-2 -mx-1 cursor-pointer w-[calc(100%+8px)] text-left min-h-[36px] leading-none"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Camera</span>
        <CameraStatusPill state={pillState} />
        <Chevron open={open} />
      </button>

      {open && (
        <div
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className="flex flex-col gap-2.5"
        >
          <p className="m-0 text-[10px] leading-[1.5] text-white/45">
            Replaces the simulator's camera feed by injecting a dylib at app launch
            and streaming frames into shared memory. Pick media or a webcam,
            then Play to inject into the foreground app.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={onFilePicked as any}
          />

          <div
            onClick={(e) => {
              if (!isPlaceholder) return;
              if ((e.target as HTMLElement).closest("[data-clear-media]")) return;
              openFilePicker();
            }}
            title={
              isPlaceholder
                ? "No source selected — Play uses a test-pattern feed. Click to pick an image/video, or drop one here."
                : showWebcam
                  ? `Source: ${activeWebcamName}`
                  : `Source: ${droppedFileName ?? source}`
            }
            className={[
              "relative min-h-[44px] flex flex-row items-center justify-center gap-2.5 px-3.5 py-2.5 rounded-[7px] text-center transition-[border-color,background] duration-150",
              isPlaceholder
                ? "bg-white/[0.04] border border-dashed border-white/12"
                : "bg-white/[0.04] border border-white/8",
              isDragOver ? "!bg-[rgba(10,132,255,0.08)] !border-[rgba(10,132,255,0.6)]" : "",
              uploading ? "cursor-progress" : isPlaceholder ? "cursor-pointer" : "cursor-default",
            ].join(" ")}
          >
            <CameraMediaPreview
              mode={tileMode}
              fileName={droppedFileName}
              webcamName={activeWebcamName}
              sourceKind={source}
            />

            {!isPlaceholder && !uploading && (
              <button
                data-clear-media
                onClick={(e) => { e.stopPropagation(); clearMedia(); }}
                className="shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none text-white/55 hover:text-white/90 cursor-pointer p-0"
                aria-label="Clear source"
                title="Clear → placeholder"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          {isPlaceholder && !uploading && <CameraTestPatternHint />}

          <div className="flex items-stretch gap-1.5">
            <div className="relative" data-camera-source-menu>
              <button
                onClick={() => setSourceMenuOpen((o) => !o)}
                className="lem-ghost h-full min-h-[36px] w-10 flex items-center justify-center bg-transparent border border-white/12 text-white/85 rounded-[7px] cursor-pointer p-0"
                aria-haspopup="menu"
                aria-expanded={sourceMenuOpen}
                title={
                  source === "webcam"
                    ? `Source: webcam${webcamId ? ` (${webcams.find((w) => w.id === webcamId)?.name ?? webcamId})` : ""} — click to change`
                    : `Source: ${source} — click to pick media or webcam`
                }
                aria-label="Choose camera source"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
                  <path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
                  <circle cx="13" cy="7" r="1" fill="currentColor" />
                  <rect x="8" y="2" width="14" height="14" rx="2" />
                </svg>
              </button>

              {sourceMenuOpen && (
                <div
                  role="menu"
                  className="absolute top-[calc(100%+6px)] left-0 z-10 min-w-[200px] flex flex-col gap-px p-1 bg-panel border border-white/8 rounded-[7px] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                >
                  <button
                    role="menuitem"
                    className="text-left bg-transparent border-none text-white/85 text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]"
                    onClick={() => { setSourceMenuOpen(false); openFilePicker(); }}
                    title="Pick an image or video from disk"
                  >
                    Browse media…
                  </button>
                  <div className="h-px bg-white/8 my-1" />
                  <div className="flex items-center justify-between pl-2.5 pr-2 pt-1 pb-[2px]">
                    <span className="text-[10px] text-white/45 uppercase tracking-[0.08em]">
                      {webcamLoading ? "Cameras (loading…)" : webcams.length === 0 ? "No cameras" : "Cameras"}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); void refreshWebcams(); }}
                      disabled={webcamLoading}
                      className="flex items-center justify-center w-[22px] h-[22px] bg-transparent border-none rounded-[5px] text-white/55 hover:text-white/90 cursor-pointer p-0 disabled:opacity-50"
                      aria-label="Refresh cameras"
                      title="Refresh cameras"
                    >
                      <ReloadIcon size={13} strokeWidth={2} />
                    </button>
                  </div>
                  {webcams.map((w) => {
                    const active = source === "webcam" && webcamId === w.id;
                    return (
                      <button
                        key={w.id}
                        role="menuitem"
                        className={[
                          "text-left bg-transparent border-none text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]",
                          active ? "!bg-white/[0.12] !text-white" : "text-white/85",
                        ].join(" ")}
                        onClick={() => {
                          setWebcamId(w.id);
                          setSource("webcam");
                          setSourceMenuOpen(false);
                        }}
                        title={w.name}
                      >
                        {w.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              onClick={primary.onClick}
              disabled={primaryDisabled}
              className={[
                "flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 border-none rounded-[7px] text-[12px] font-semibold cursor-pointer disabled:opacity-50 min-h-[36px]",
                primary.kind === "stop"
                  ? "lem-primary lem-primary-on bg-white/[0.16] text-white"
                  : "lem-primary bg-success-emerald text-[#062018]",
              ].join(" ")}
              title={
                !bundleId ? "Bring an app to the foreground first" :
                primary.kind === "stop" ? "Stop the camera helper" :
                primary.kind === "attach" ? `Inject ${bundleId} so it joins the camera feed` :
                "Start: inject the dylib and launch the foreground app with the chosen source"
              }
              aria-pressed={primary.kind === "stop"}
              aria-label={primary.kind === "stop" ? "Stop" : "Play"}
            >
              {primary.kind === "stop" ? <StopGlyph /> : <PlayGlyph />}
              <span>{primary.kind === "stop" ? "Stop" : primary.kind === "attach" ? "Inject" : "Play"}</span>
            </button>

            <div className="relative">
              <button
                onClick={toggleMirror}
                className="lem-ghost h-full min-h-[36px] w-10 flex items-center justify-center bg-transparent border border-white/12 text-white/85 rounded-[7px] cursor-pointer p-0"
                title={
                  mirrorIsManual
                    ? `Mirror: ${mirrorDisplay} (manual) — click to flip`
                    : `Mirror: auto (${mirrorDisplay}) — click to override`
                }
                aria-label={`Mirror: ${mirrorDisplay}${mirrorIsManual ? " (manual)" : " (auto)"}`}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill={mirrorDisplay === "on" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 7 5 5-5 5V7" />
                  <path d="m21 7-5 5 5 5V7" />
                  <path d="M12 20v2" stroke="currentColor" fill="none" />
                  <path d="M12 14v2" stroke="currentColor" fill="none" />
                  <path d="M12 8v2" stroke="currentColor" fill="none" />
                  <path d="M12 2v2" stroke="currentColor" fill="none" />
                </svg>
              </button>
              {mirrorIsManual && (
                <button
                  onClick={revertMirrorToAuto}
                  className="absolute -top-[5px] -right-[5px] w-4 h-4 flex items-center justify-center bg-white/20 border border-panel text-white rounded-full cursor-pointer p-0"
                  aria-label="Revert mirror to auto"
                  title="Revert to auto mirror"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {warning && <CameraInlineBanner kind="warning" message={warning} />}
          {error && <CameraInlineBanner kind="error" message={error} />}
        </div>
      )}
    </div>
  );
}
