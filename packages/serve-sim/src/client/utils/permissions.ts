export const PERMISSION_SERVICES: { key: string; label: string }[] = [
  { key: "camera", label: "Camera" },
  { key: "microphone", label: "Microphone" },
  { key: "photos", label: "Photos" },
  { key: "photos-add", label: "Add to Photos" },
  { key: "contacts", label: "Contacts" },
  { key: "calendar", label: "Calendar" },
  { key: "reminders", label: "Reminders" },
  { key: "location", label: "Location" },
  { key: "location-always", label: "Location (Always)" },
  { key: "motion", label: "Motion" },
  { key: "media-library", label: "Media Library" },
  { key: "siri", label: "Siri" },
];

export type PermAction = "grant" | "revoke" | "reset";
export type PermState = Record<string, PermAction | undefined>;
