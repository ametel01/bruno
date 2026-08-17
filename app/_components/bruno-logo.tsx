type BrunoLogoProps = {
  className?: string | undefined;
  compact?: boolean;
};

export function BrunoLogo({ className, compact = false }: BrunoLogoProps) {
  return (
    <span className={className} data-compact={compact || undefined}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 64 76">
        <path d="M25 68H9V7h22c12.5 0 21 8.5 21 20 0 6-2.5 10.5-7.5 13" />
        <path d="M44.5 39H29c-9.5 0-15 6.5-15 15s6 14 15 14h15c9 0 15-6 15-14 0-7-5-12-12-15" />
        <path d="m17 22 12 9 13-9" />
        <circle className="bruno-logo__mint" cx="45" cy="39" r="4.7" />
        <circle className="bruno-logo__lime" cx="25" cy="68" r="4.7" />
      </svg>
      {compact ? null : (
        <span>
          Bruno
          <span aria-hidden="true" style={{ color: "var(--bruno-logo-dot, currentColor)" }}>
            .
          </span>
          Ai
        </span>
      )}
    </span>
  );
}
