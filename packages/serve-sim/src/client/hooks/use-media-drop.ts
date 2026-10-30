import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  type DropKind,
  addHostMediaToPhotos,
  dropKindFor,
  DROP_HOST_PATH_TYPE,
  uploadDroppedFile,
} from "../utils/drop";
import type { HostActionFn } from "../utils/exec";

type UploadCallbacks = {
  onUploadStart: (name: string, kind: DropKind) => string;
  onUploadProgress: (id: string, progress: number | null) => void;
  onUploadEnd: (id: string, ok: boolean, message?: string) => void;
};

export function startHostPathDrop({
  hostPath,
  host,
  udid,
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onHostPathDrop,
}: {
  hostPath: string;
  host: HostActionFn;
  udid: string;
  onHostPathDrop?: (path: string) => void;
} & UploadCallbacks): Promise<void> {
  onHostPathDrop?.(hostPath);
  const name = hostPath.split("/").pop() ?? "image";
  const id = onUploadStart(name, "media");
  onUploadProgress(id, null);
  return addHostMediaToPhotos(hostPath, host, udid)
    .then(() => onUploadEnd(id, true))
    .catch((err) =>
      onUploadEnd(id, false, err instanceof Error ? err.message : "Add failed"),
    );
}

export function useMediaDrop({
  host,
  udid,
  enabled,
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onUnsupported,
  onHostPathDrop,
}: {
  host: HostActionFn;
  udid: string | undefined;
  enabled: boolean;
  onUploadStart: (name: string, kind: DropKind) => string;
  onUploadProgress: (id: string, progress: number | null) => void;
  onUploadEnd: (id: string, ok: boolean, message?: string) => void;
  onUnsupported: (file: File) => void;
  onHostPathDrop?: (path: string) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setIsDragOver(false);

      if (!enabled || !udid) return;

      // In-app drag (the screenshot pill) hands us a host path — the file is
      // already on disk, so addmedia it directly instead of uploading.
      const hostPath = e.dataTransfer.getData(DROP_HOST_PATH_TYPE);
      if (hostPath) {
        void startHostPathDrop({
          hostPath,
          host,
          udid,
          onUploadStart,
          onUploadProgress,
          onUploadEnd,
          onHostPathDrop,
        });
        return;
      }

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const file of files) {
        const kind = dropKindFor(file);
        if (!kind) {
          onUnsupported(file);
          continue;
        }
        const id = onUploadStart(file.name, kind);
        uploadDroppedFile(file, kind, host, udid, (p) => onUploadProgress(id, p), {
          allowInstall: window.__SIM_PREVIEW__?.allowExec === true,
        })
          .then(() => onUploadEnd(id, true))
          .catch((err) =>
            onUploadEnd(id, false, err instanceof Error ? err.message : "Upload failed"),
          );
      }
    },
    [
      enabled,
      udid,
      host,
      onUploadStart,
      onUploadProgress,
      onUploadEnd,
      onUnsupported,
      onHostPathDrop,
    ],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (enabled) e.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (!enabled) return;
      dragCountRef.current++;
      if (dragCountRef.current === 1) setIsDragOver(true);
    },
    [enabled],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  return {
    isDragOver,
    dropZoneProps: { onDragOver, onDragEnter, onDragLeave, onDrop: handleDrop },
  };
}
