import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { ReloadIcon } from "../icons";
import { execOnHost, shellEscape } from "../utils/exec";
import { fileExtension, uploadFileToTmp } from "../utils/drop";

type CamSource = "placeholder" | "image" | "video" | "webcam";
type CamMirror = "auto" | "on" | "off";
interface CamWebcam { id: string; name: string }

export function CameraPanel({
  open,
  onClose,
  udid,
  bundleId,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  bundleId: string | null;
  width: number;
}) {
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
  const [, setStatus] = useState<string | null>(null);
  const [injected, setInjected] = useState(false);
  // Track every bundle we've launched with the dylib so the primary button
  // can read "Inject <NewApp>" when the foreground changes to one that
  // hasn't joined the running helper yet.
  const [injectedBundleIds, setInjectedBundleIds] = useState<Set<string>>(() => new Set());
  // Suppress the next auto-swap / auto-mirror effect when state was hydrated
  // from the live helper's status (page reload, not a user edit) so we don't
  // bounce its AVCaptureSession.
  const skipNextAutoSwapRef = useRef(false);
  const skipNextAutoMirrorRef = useRef(false);

  const cliPrefix = useMemo(() => {
    const bin = window.__SIM_PREVIEW__?.serveSimBin;
    if (!bin) return "serve-sim";
    return /\.js$/.test(bin) ? `node ${shellEscape(bin)}` : shellEscape(bin);
  }, []);

  // Reattach to the existing helper across page reloads.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await execOnHost(`${cliPrefix} camera status -d ${udid}`);
        if (cancelled || res.exitCode !== 0) return;
        const reply = JSON.parse(res.stdout.trim()) as {
          alive?: boolean;
          source?: string;
          arg?: string;
          mirror?: string;
        };
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
        setStatus(`Reattached → ${reply.source ?? "running helper"}${reply.arg ? ` (${reply.arg})` : ""}`);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [udid, cliPrefix]);

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
    if (open && webcams.length === 0 && !webcamLoading) void refreshWebcams();
  }, [open, webcams.length, webcamLoading, refreshWebcams]);

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
      setError(res.stderr.trim() || res.stdout.trim() || `switch failed (${res.exitCode})`);
      return false;
    }
    try {
      const json = JSON.parse(res.stdout.trim()) as { source?: string; arg?: string };
      setStatus(`Switched → ${json.source ?? nextSource}${json.arg ? ` (${json.arg})` : ""}`);
    } catch {
      setStatus(`Switched → ${nextSource}`);
    }
    return true;
  }, [udid, cliPrefix]);

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
        setError(res.stderr.trim() || res.stdout.trim() || `inject failed (${res.exitCode})`);
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
      setInjectedBundleIds((prev) => prev.has(bundleId) ? prev : new Set(prev).add(bundleId));
    } finally {
      setPending(null);
    }
  }, [bundleId, udid, source, filePath, webcamId, mirror, cliPrefix]);

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
      setInjectedBundleIds(new Set());
    } finally {
      setPending(null);
    }
  }, [udid, cliPrefix]);

  const handleSourceFile = useCallback(async (file: File) => {
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) {
      setError(`Unsupported file type: ${file.type || file.name}`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const ext = fileExtension(file);
      const tmpPath = await uploadFileToTmp(file, "serve-sim-camsrc", ext, execOnHost);
      setDroppedFileName(file.name);
      setSource(isVideo ? "video" : "image");
      setFilePath(tmpPath);
      setStatus(`Loaded ${file.name}`);
    } catch (e: any) {
      setError(e?.message ?? "Upload failed");
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

  return (
    <Panel open={open} width={width}>
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <PanelHeader>
          <PanelTitle>Camera</PanelTitle>
          <PanelCloseButton onClick={onClose} />
        </PanelHeader>

        {open && (
          <div className="p-3.5 overflow-y-auto flex-1 flex flex-col">
            <p style={cameraPanelStyles.subtitle}>
              Replaces the simulator's camera feed by injecting a dylib at launch
              and streaming frames into shared memory. Pick media or a webcam,
              then Play to inject into the foreground app.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              style={{ display: "none" }}
              onChange={onFilePicked as any}
            />

            {(() => {
              const isPlaceholder = source === "placeholder";
              const showWebcam = source === "webcam";
              const showFile = (source === "image" || source === "video") && !!droppedFileName;
              const activeWebcamName = showWebcam
                ? (webcams.find((w) => w.id === webcamId)?.name ?? webcamId ?? "Webcam")
                : null;
              return (
                <div
                  onClick={(e) => {
                    if (!isPlaceholder) return;
                    if ((e.target as HTMLElement).closest("[data-clear-media]")) return;
                    openFilePicker();
                  }}
                  title={
                    isPlaceholder
                      ? "Click to select an image or video, or drop one here"
                      : showWebcam
                        ? `Source: ${activeWebcamName}`
                        : `Source: ${droppedFileName ?? source}`
                  }
                  style={{
                    ...cameraPanelStyles.dropZone,
                    ...(isPlaceholder ? null : cameraPanelStyles.dropZoneFilled),
                    ...(isDragOver ? cameraPanelStyles.dropZoneActive : null),
                    cursor: uploading ? "progress" : isPlaceholder ? "pointer" : "default",
                    position: "relative",
                  }}
                >
                  {uploading ? (
                    <span style={cameraPanelStyles.dropHint}>Uploading…</span>
                  ) : showFile ? (
                    <>
                      <div style={cameraPanelStyles.sourceBadge}>
                        {source === "video" ? "Video" : "Image"}
                      </div>
                      <span style={cameraPanelStyles.dropFilename}>{droppedFileName}</span>
                    </>
                  ) : showWebcam ? (
                    <>
                      <div style={cameraPanelStyles.sourceBadge}>Webcam</div>
                      <span style={cameraPanelStyles.dropFilename}>{activeWebcamName}</span>
                    </>
                  ) : (
                    <span style={cameraPanelStyles.dropTitle}>Select or drop media</span>
                  )}

                  {!isPlaceholder && !uploading && (
                    <button
                      data-clear-media
                      onClick={(e) => { e.stopPropagation(); clearMedia(); }}
                      style={cameraPanelStyles.clearBtn}
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
              );
            })()}

            <div style={cameraPanelStyles.controls}>
              <div style={{ position: "relative" }} data-camera-source-menu>
                <button
                  onClick={() => setSourceMenuOpen((o) => !o)}
                  style={cameraPanelStyles.iconButton}
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
                  <div style={cameraPanelStyles.menu} role="menu">
                    <button
                      role="menuitem"
                      style={cameraPanelStyles.menuItem}
                      onClick={() => { setSourceMenuOpen(false); openFilePicker(); }}
                      title="Pick an image or video from disk"
                    >
                      Browse media…
                    </button>
                    <div style={cameraPanelStyles.menuSeparator} />
                    <div style={cameraPanelStyles.menuLabelRow}>
                      <span style={cameraPanelStyles.menuLabel}>
                        {webcamLoading ? "Cameras (loading…)" : webcams.length === 0 ? "No cameras" : "Cameras"}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); void refreshWebcams(); }}
                        disabled={webcamLoading}
                        style={cameraPanelStyles.menuRefreshBtn}
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
                          style={{
                            ...cameraPanelStyles.menuItem,
                            ...(active ? cameraPanelStyles.menuItemActive : null),
                          }}
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
                style={{
                  ...cameraPanelStyles.playBtn,
                  ...(primary.kind === "stop" ? cameraPanelStyles.stopBtn : null),
                  opacity: primaryDisabled ? 0.5 : 1,
                }}
                title={
                  !bundleId ? "Bring an app to the foreground first" :
                  primary.kind === "stop" ? "Stop the camera helper" :
                  primary.kind === "attach" ? `Inject ${bundleId} so it joins the camera feed` :
                  "Start: inject the dylib and launch the foreground app with the chosen source"
                }
                aria-label={primary.kind === "stop" ? "Stop" : "Play"}
              >
                {primary.kind === "stop" ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="1.5" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <div style={{ position: "relative" }}>
                <button
                  onClick={toggleMirror}
                  style={cameraPanelStyles.iconButton}
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
                    style={cameraPanelStyles.mirrorBadge}
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

            {error && (
              <div className="mt-3 text-[11px] text-red-400 font-mono break-words">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

const cameraPanelStyles: Record<string, CSSProperties> = {
  subtitle: {
    margin: "0 0 14px",
    fontSize: 11,
    lineHeight: 1.5,
    color: "#888",
  },
  dropZone: {
    minHeight: 44,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: "10px 14px",
    background: "#0e0e10",
    border: "1px dashed #2a2a2c",
    borderRadius: 10,
    textAlign: "center",
    transition: "border-color 0.15s, background 0.15s",
  },
  dropZoneActive: {
    background: "rgba(10,132,255,0.08)",
    borderColor: "rgba(10,132,255,0.6)",
  },
  dropZoneFilled: {
    background: "#141416",
    border: "1px solid #232325",
  },
  sourceBadge: {
    fontSize: 9,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "#888",
    background: "#18181a",
    border: "1px solid #232325",
    padding: "2px 7px",
    borderRadius: 999,
    flexShrink: 0,
  },
  dropTitle: { fontSize: 12, color: "#eee", fontWeight: 600 },
  dropHint: { fontSize: 11, color: "#777" },
  dropFilename: {
    fontSize: 12,
    color: "#fff",
    fontFamily: "ui-monospace, monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
  },
  clearBtn: {
    width: 20,
    height: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "#888",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
    marginTop: 16,
  },
  iconButton: {
    width: 40,
    height: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1c1c1e",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#eee",
    borderRadius: 10,
    cursor: "pointer",
    padding: 0,
  },
  mirrorBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 16,
    height: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.14)",
    border: "1px solid #0a0a0a",
    color: "#fff",
    borderRadius: "50%",
    cursor: "pointer",
    padding: 0,
  },
  playBtn: {
    width: 52,
    height: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0a84ff",
    border: "none",
    color: "#fff",
    borderRadius: "50%",
    cursor: "pointer",
    padding: 0,
  },
  stopBtn: { background: "#ff453a" },
  menu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    minWidth: 200,
    background: "#1c1c1e",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 10,
    padding: 4,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  menuItem: {
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "#eee",
    fontSize: 12,
    padding: "7px 10px",
    borderRadius: 6,
    cursor: "pointer",
  },
  menuItemActive: { background: "rgba(10,132,255,0.18)", color: "#fff" },
  menuSeparator: {
    height: 1,
    background: "rgba(255,255,255,0.08)",
    margin: "4px 0",
  },
  menuLabel: {
    fontSize: 10,
    color: "#777",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  menuLabelRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 8px 2px 10px",
  },
  menuRefreshBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "transparent",
    border: "none",
    borderRadius: 5,
    color: "#888",
    cursor: "pointer",
    padding: 0,
  },
};
