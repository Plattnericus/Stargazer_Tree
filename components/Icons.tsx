// Minimal inline line-icons (Feather-style), no dependency. Stroke inherits
// currentColor so they match text.

type P = { className?: string };

function Svg({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SearchIcon = ({ className }: P) => (
  <Svg className={className}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </Svg>
);

export const PlusIcon = ({ className }: P) => (
  <Svg className={className}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

export const MinusIcon = ({ className }: P) => (
  <Svg className={className}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

export const CloseIcon = ({ className }: P) => (
  <Svg className={className}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Svg>
);

// navigation arrow — used for "fly" mode
export const FlyIcon = ({ className }: P) => (
  <Svg className={className}>
    <polygon points="3 11 22 2 13 21 11 13 3 11" />
  </Svg>
);

export const StarIcon = ({ className }: P) => (
  <Svg className={className}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </Svg>
);

export const SunIcon = ({ className }: P) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2" x2="12" y2="4" />
    <line x1="12" y1="20" x2="12" y2="22" />
    <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
    <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
    <line x1="2" y1="12" x2="4" y2="12" />
    <line x1="20" y1="12" x2="22" y2="12" />
    <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
    <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
  </Svg>
);

export const CloudIcon = ({ className }: P) => (
  <Svg className={className}>
    <path d="M17.5 18H8a5 5 0 1 1 1.2-9.85A6.5 6.5 0 0 1 21 12a3.5 3.5 0 0 1-3.5 6z" />
  </Svg>
);

export const RainIcon = ({ className }: P) => (
  <Svg className={className}>
    <path d="M17.5 16H8a5 5 0 1 1 1.2-9.85A6.5 6.5 0 0 1 21 10a3.5 3.5 0 0 1-3.5 6z" />
    <line x1="8" y1="20" x2="9" y2="22" />
    <line x1="12" y1="19" x2="13" y2="21" />
    <line x1="16" y1="20" x2="17" y2="22" />
  </Svg>
);

export const SnowIcon = ({ className }: P) => (
  <Svg className={className}>
    <line x1="12" y1="3" x2="12" y2="21" />
    <line x1="4.2" y1="7.5" x2="19.8" y2="16.5" />
    <line x1="19.8" y1="7.5" x2="4.2" y2="16.5" />
  </Svg>
);

export const StormIcon = ({ className }: P) => (
  <Svg className={className}>
    <path d="M17.5 14H8a5 5 0 1 1 1.2-9.85A6.5 6.5 0 0 1 21 8a3.5 3.5 0 0 1-3.5 6z" />
    <polyline points="13 14 10 20 15 20 12 23" />
  </Svg>
);

export const FogIcon = ({ className }: P) => (
  <Svg className={className}>
    <line x1="4" y1="8" x2="20" y2="8" />
    <line x1="2" y1="12" x2="15" y2="12" />
    <line x1="9" y1="16" x2="22" y2="16" />
    <line x1="5" y1="20" x2="18" y2="20" />
  </Svg>
);

export const ClockIcon = ({ className }: P) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 14" />
  </Svg>
);

export const CalendarIcon = ({ className }: P) => (
  <Svg className={className}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </Svg>
);

export const WindIcon = ({ className }: P) => (
  <Svg className={className}>
    <path d="M3 8h11a3 3 0 1 0-3-3" />
    <path d="M3 12h16" />
    <path d="M3 16h9a3 3 0 1 1-3 3" />
  </Svg>
);
