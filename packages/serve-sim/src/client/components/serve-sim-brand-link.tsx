export const SERVE_SIM_REPO_URL = "https://github.com/EvanBacon/serve-sim";

export function ServeSimBrandLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={SERVE_SIM_REPO_URL}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex h-[30px] min-w-0 items-center whitespace-nowrap rounded-md px-1.5 font-mono text-[12px] font-semibold text-white/65 no-underline [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 ${className}`.trim()}
      aria-label="Open serve-sim"
      title="Open serve-sim"
    >
      serve-sim
    </a>
  );
}
