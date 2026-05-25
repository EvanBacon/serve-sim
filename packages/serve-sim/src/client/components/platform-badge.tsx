export type DevicePlatform = "ios" | "android";

export function platformLabel(platform?: DevicePlatform): string {
  return platform === "android" ? "Android" : "iOS";
}

export function PlatformBadge({
  platform,
  compact = false,
  className = "",
}: {
  platform?: DevicePlatform;
  compact?: boolean;
  className?: string;
}) {
  const android = platform === "android";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] border font-mono uppercase ${compact ? "h-[18px] px-1.5 text-[9px]" : "h-[20px] px-2 text-[10px]"} ${android ? "border-[#22c55e] bg-[#052e24] text-[#bbf7d0]" : "border-[#60a5fa] bg-[#0b1f3a] text-[#dbeafe]"} ${className}`}
    >
      {android ? "Android" : "iOS"}
    </span>
  );
}
