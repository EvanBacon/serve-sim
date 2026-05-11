import { useCallback, useRef, useState, type DragEvent } from "react";
import { type DropKind, dropKindFor, uploadDroppedFile } from "../utils/drop";
import type { ExecResult } from "../utils/exec";

export function useMediaDrop({
  exec,
  udid,
  enabled,
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onUnsupported,
}: {
  exec: (command: string) => Promise<ExecResult>;
  udid: string | undefined;
  enabled: boolean;
  onUploadStart: (name: string, kind: DropKind) => string;
  onUploadProgress: (id: string, progress: number | null) => void;
  onUploadEnd: (id: string, ok: boolean, message?: string) => void;
  onUnsupported: (file: File) => void;
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

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const file of files) {
        const kind = dropKindFor(file);
        if (!kind) {
          onUnsupported(file);
          continue;
        }
        const id = onUploadStart(file.name, kind);
        uploadDroppedFile(file, kind, exec, udid, (p) => onUploadProgress(id, p))
          .then(() => onUploadEnd(id, true))
          .catch((err) =>
            onUploadEnd(id, false, err instanceof Error ? err.message : "Upload failed"),
          );
      }
    },
    [enabled, udid, exec, onUploadStart, onUploadProgress, onUploadEnd, onUnsupported],
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
