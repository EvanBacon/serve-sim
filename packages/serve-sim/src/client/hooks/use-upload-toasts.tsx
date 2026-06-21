import { useCallback, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { UploadToastContent } from "../components/app-toasts";
import type { DropKind } from "../utils/drop";

export type UploadToast = {
  id: string;
  name: string;
  kind: DropKind;
  status: "uploading" | "success" | "error";
  // Determinate transfer progress 0..1; null once the upload completes
  // (install/addmedia phase has no progress signal — the bar goes indeterminate).
  progress: number | null;
  message?: string;
};

export function useUploadToasts() {
  const toastsRef = useRef(new Map<string, UploadToast>());
  const dismissTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearDismissTimer = useCallback((id: string) => {
    const timer = dismissTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    dismissTimersRef.current.delete(id);
  }, []);

  const render = useCallback((toast: UploadToast, duration = Infinity) => {
    sonnerToast.custom(
      () => <UploadToastContent toast={toast} />,
      { id: toast.id, duration },
    );
  }, []);

  const add = useCallback((name: string, kind: DropKind): string => {
    const id = crypto.randomUUID();
    const next: UploadToast = { id, name, kind, status: "uploading", progress: 0 };
    toastsRef.current.set(id, next);
    render(next);
    return id;
  }, [render]);

  const update = useCallback((id: string, patch: Partial<UploadToast>) => {
    const current = toastsRef.current.get(id);
    if (!current) return;
    clearDismissTimer(id);
    const next = { ...current, ...patch };
    toastsRef.current.set(id, next);
    render(next, patch.status === "success" || patch.status === "error" ? 3000 : Infinity);
    if (patch.status === "success" || patch.status === "error") {
      const timer = setTimeout(() => {
        toastsRef.current.delete(id);
        dismissTimersRef.current.delete(id);
      }, 3000);
      dismissTimersRef.current.set(id, timer);
    }
  }, [clearDismissTimer, render]);

  const setProgress = useCallback((id: string, progress: number | null) => {
    const current = toastsRef.current.get(id);
    if (!current) return;
    const next = { ...current, progress };
    toastsRef.current.set(id, next);
    render(next);
  }, [render]);

  return { add, update, setProgress };
}
