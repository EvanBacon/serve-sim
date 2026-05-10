import { useCallback, useState } from "react";
import type { DropKind } from "../utils/drop";

export type UploadToast = {
  id: string;
  name: string;
  kind: DropKind;
  status: "uploading" | "success" | "error";
  message?: string;
};

export function useUploadToasts() {
  const [toasts, setToasts] = useState<UploadToast[]>([]);
  const add = useCallback((name: string, kind: DropKind): string => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, name, kind, status: "uploading" }]);
    return id;
  }, []);
  const update = useCallback((id: string, patch: Partial<UploadToast>) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    // Auto-dismiss finished toasts after 3s.
    if (patch.status === "success" || patch.status === "error") {
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, 3000);
    }
  }, []);
  return { toasts, add, update };
}
