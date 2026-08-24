interface BrandMarkProps {
  className?: string;
}

export function BrandMark({ className }: BrandMarkProps): React.JSX.Element {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="1024"
      height="1024"
      viewBox="0 0 1024 1024"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="brand-mark-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent-strong)" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill="url(#brand-mark-gradient)" />
      <path
        d="M307 307H717 M307 512H676 M307 717H717 M307 251V773"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="112"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
      <path d="M717 190L818 408L717 475Z" fill="var(--accent)" />
    </svg>
  );
}
