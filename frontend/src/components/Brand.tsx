/** Brand lockup: gradient mark + wordmark. size="lg" for prominent placements like the landing header. */
export default function Brand({ size = "default" }: { size?: "default" | "lg" }) {
  const lg = size === "lg";
  return (
    <span className="flex items-center gap-2.5 select-none">
      <span
        className={`flex items-center justify-center rounded-lg border border-line bg-panel ${
          lg ? "h-11 w-11 rounded-xl" : "h-7 w-7"
        }`}
      >
        <svg width={lg ? 26 : 16} height={lg ? 26 : 16} viewBox="0 0 64 64" fill="none">
          <defs>
            <linearGradient id="bmark" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#F2A65A" />
              <stop offset="1" stopColor="#5FD4C0" />
            </linearGradient>
          </defs>
          <rect x="10" y="10" width="44" height="44" rx="7" stroke="url(#bmark)" strokeWidth="5" fill="none" />
          <path d="M20 6v9M44 6v9M14 25h36M14 32h36M14 39h36M14 46h36" stroke="url(#bmark)" strokeWidth="4.5" strokeLinecap="round" />
        </svg>
      </span>
      <span
        className={`font-display font-semibold tracking-tight text-busy ${
          lg ? "text-2xl" : "text-sm"
        }`}
      >
        Schedule<span className="text-signal"> Assistant</span>
      </span>
    </span>
  );
}
