import { useState, useCallback, useEffect, useRef } from "react";

/** Matches the JSON output of `serve-sim --detach` and `serve-sim --list`. */
export interface SimStreamInfo {
  url: string;
  streamUrl: string;
  wsUrl: string;
  port: number;
  device: string;
}

export interface UseSimStreamOptions {
  /** Gateway exec function: `(command: string) => Promise<{ stdout: string; exitCode: number }>` */
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Device name or UDID. When changed while streaming, auto-switches to the new device. */
  device?: string | null;
}

export interface UseSimStreamResult {
  /** Connection info when a serve-sim server is running, null otherwise. */
  info: SimStreamInfo | null;
  /** Whether a connect/disconnect operation is in progress. */
  loading: boolean;
  /** Last error message, if any. */
  error: string | null;
  /** Start streaming. Optionally specify a device name/UDID and port. Returns true on success. */
  connect: (device?: string, port?: number) => Promise<boolean>;
  /** Stop the running serve-sim server. */
  disconnect: () => Promise<void>;
  /** Send a button press (home, app_switcher) via the CLI. */
  sendButton: (button: string) => Promise<void>;
}

export function useSimStream({ exec, device: deviceProp }: UseSimStreamOptions): UseSimStreamResult {
  const [info, setInfo] = useState<SimStreamInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const infoRef = useRef(info);
  infoRef.current = info;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Auto-connect/switch when deviceProp changes.
  // `serve-sim --detach` handles booting, tearing down a previous server
  // for a different device, and returning early if already streaming the
  // requested device — so we just call it with the new UDID.
  const prevDeviceProp = useRef(deviceProp);
  useEffect(() => {
    const prev = prevDeviceProp.current;
    prevDeviceProp.current = deviceProp;

    // Only act if the prop actually changed
    if (deviceProp === prev) return;

    // If the new device is already the one being streamed, skip
    if (deviceProp && infoRef.current?.device === deviceProp) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (!deviceProp) {
          // No device selected — just disconnect
          await exec("serve-sim --kill");
          if (mountedRef.current) setInfo(null);
          return;
        }
        const result = await exec(`serve-sim --detach ${deviceProp}`);
        if (cancelled) return;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || `serve-sim --detach failed (exit ${result.exitCode})`);
        }
        const parsed = JSON.parse(result.stdout.trim()) as SimStreamInfo;
        if (mountedRef.current) setInfo(parsed);
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to switch device");
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [deviceProp, exec]);

  const connect = useCallback(async (device?: string, port?: number): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    console.log(`[serve-sim] connect: starting`);
    try {
      const target = device ?? deviceProp ?? undefined;
      let cmd = "serve-sim --detach";
      if (target) cmd += ` ${target}`;
      if (port) cmd += ` --port ${port}`;

      const result = await exec(cmd);
      console.log(`[serve-sim] connect: exec returned (+${(performance.now() - t0).toFixed(0)}ms, exit ${result.exitCode})`);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `serve-sim --detach failed (exit ${result.exitCode})`);
      }
      const parsed = JSON.parse(result.stdout.trim()) as SimStreamInfo;
      if (mountedRef.current) setInfo(parsed);
      return true;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to connect");
      }
      return false;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [exec, deviceProp]);

  const disconnect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await exec("serve-sim --kill");
      if (mountedRef.current) setInfo(null);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to disconnect");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [exec]);

  const sendButton = useCallback(async (button: string) => {
    try {
      await exec(`serve-sim button ${button}`);
    } catch {
      // best-effort
    }
  }, [exec]);

  return { info, loading, error, connect, disconnect, sendButton };
}
