type BrunoLogoProps = {
  className?: string | undefined;
  compact?: boolean;
};

export function BrunoLogo({ className, compact = false }: BrunoLogoProps) {
  return (
    <span className={className} data-compact={compact || undefined}>
      <svg aria-hidden="true" viewBox="0 0 54 58">
        <path d="M9 4h18c9 0 16 6 16 15 0 5-2 9-7 12 7 2 11 7 11 14 0 6-3 10-7 13H9V4Z" />
        <path d="m15 17 10 8 10-8" />
        <path d="M14 49c0-9 5-15 14-15 8 0 14 5 14 13 0 5-2 8-6 11H14v-9Z" />
        <circle className="bruno-logo__mint" cx="37" cy="29" r="5" />
        <circle className="bruno-logo__lime" cx="18" cy="55" r="5" />
      </svg>
      {compact ? null : (
        <span>
          Bruno
          <span aria-hidden="true" style={{ color: "var(--bruno-logo-dot, currentColor)" }}>
            .
          </span>
        </span>
      )}
    </span>
  );
}
