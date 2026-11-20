// Single permission catalogue shared by the preview panel, host-rpc's
// validation and the `serve-sim permissions list` CLI. Pure: no node or DOM
// imports, so it bundles into the client and runs in tests.

export interface PermissionService {
  /** Name accepted by `serve-sim permissions grant|revoke|reset`. */
  key: string;
  label: string;
  /**
   * Info.plist keys whose presence means the app asks for this permission.
   * Empty for notifications (see `requestedPermissions`).
   */
  usageKeys: string[];
}

export const PERMISSION_SERVICES: PermissionService[] = [
  { key: "camera", label: "Camera", usageKeys: ["NSCameraUsageDescription"] },
  { key: "microphone", label: "Microphone", usageKeys: ["NSMicrophoneUsageDescription"] },
  { key: "photos", label: "Photos", usageKeys: ["NSPhotoLibraryUsageDescription"] },
  { key: "photos-add", label: "Add to Photos", usageKeys: ["NSPhotoLibraryAddUsageDescription"] },
  { key: "contacts", label: "Contacts", usageKeys: ["NSContactsUsageDescription"] },
  {
    key: "calendar",
    label: "Calendar",
    usageKeys: [
      "NSCalendarsUsageDescription",
      "NSCalendarsFullAccessUsageDescription",
      "NSCalendarsWriteOnlyAccessUsageDescription",
    ],
  },
  {
    key: "reminders",
    label: "Reminders",
    usageKeys: ["NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"],
  },
  {
    key: "location",
    label: "Location",
    usageKeys: [
      "NSLocationWhenInUseUsageDescription",
      "NSLocationUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
      "NSLocationAlwaysUsageDescription",
    ],
  },
  {
    key: "location-always",
    label: "Location (Always)",
    usageKeys: ["NSLocationAlwaysAndWhenInUseUsageDescription", "NSLocationAlwaysUsageDescription"],
  },
  { key: "notifications", label: "Notifications", usageKeys: [] },
  { key: "motion", label: "Motion", usageKeys: ["NSMotionUsageDescription"] },
  { key: "media-library", label: "Media Library", usageKeys: ["NSAppleMusicUsageDescription"] },
  { key: "siri", label: "Siri", usageKeys: ["NSSiriUsageDescription"] },
  { key: "speech", label: "Speech Recognition", usageKeys: ["NSSpeechRecognitionUsageDescription"] },
  { key: "faceid", label: "Face ID", usageKeys: ["NSFaceIDUsageDescription"] },
  { key: "user-tracking", label: "Tracking", usageKeys: ["NSUserTrackingUsageDescription"] },
  { key: "homekit", label: "HomeKit", usageKeys: ["NSHomeKitUsageDescription"] },
];

export type PermAction = "grant" | "revoke" | "reset";
export type PermStatus = "granted" | "denied" | "limited" | "unset";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Catalogue keys (in catalogue order) the app declares a usage description
 * for in its Info.plist. A key counts only with a non-empty string value.
 *
 * Notifications have no usage-description key, so they're approximated by
 * `UIBackgroundModes` containing "remote-notification". Apps that only post
 * local notifications, or ask for push without that background mode, won't
 * be listed as requesting them.
 */
export function requestedPermissions(info: unknown): string[] {
  if (!isRecord(info)) return [];
  const has = (k: string) => typeof info[k] === "string" && (info[k] as string).trim() !== "";
  const modes = info.UIBackgroundModes;
  const remotePush = Array.isArray(modes) && modes.includes("remote-notification");
  return PERMISSION_SERVICES.filter(({ key, usageKeys }) =>
    key === "notifications" ? remotePush : usageKeys.some(has),
  ).map(({ key }) => key);
}

/**
 * Map the raw `serve-sim permissions list <bundle-id>` JSON (`tcc`,
 * `location`, `notifications`) to a status per catalogue key.
 *
 * - TCC `auth_value`: 2 granted, 0 denied, 3 limited; absent/other unset.
 * - locationd `Authorization`: 2 while in use, 4 always, 1 denied.
 * - BulletinBoard `allowsNotifications`: true granted, false denied.
 */
export function permissionStatuses(raw: unknown): Record<string, PermStatus> {
  const r = isRecord(raw) ? raw : {};
  const tcc = isRecord(r.tcc) ? r.tcc : {};
  const auth = isRecord(r.location) ? r.location.Authorization : undefined;
  const notif = isRecord(r.notifications) ? r.notifications.allowsNotifications : undefined;

  const out: Record<string, PermStatus> = {};
  for (const { key } of PERMISSION_SERVICES) {
    if (key === "location") {
      out[key] = auth === 2 || auth === 4 ? "granted" : auth === 1 ? "denied" : "unset";
    } else if (key === "location-always") {
      out[key] = auth === 4 ? "granted" : auth === 1 ? "denied" : "unset";
    } else if (key === "notifications") {
      out[key] = notif === true ? "granted" : notif === false ? "denied" : "unset";
    } else {
      const v = tcc[key];
      out[key] = v === 2 ? "granted" : v === 0 ? "denied" : v === 3 ? "limited" : "unset";
    }
  }
  return out;
}
