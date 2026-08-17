"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./prototype-switcher.module.css";

export type PrototypeVariant = "A" | "B" | "C";

const variants: Array<{ key: PrototypeVariant; label: string }> = [
  { key: "A", label: "Briefing desk" },
  { key: "B", label: "Conversation canvas" },
  { key: "C", label: "Decision queue" },
];

type PrototypeSwitcherProps = {
  current: PrototypeVariant;
  onChange: (variant: PrototypeVariant) => void;
};

export function PrototypeSwitcher({ current, onChange }: PrototypeSwitcherProps) {
  const [collapsed, setCollapsed] = useState(false);
  const currentIndex = variants.findIndex((variant) => variant.key === current);

  const cycle = useCallback(
    (direction: -1 | 1) => {
      const nextIndex = (currentIndex + direction + variants.length) % variants.length;
      const next = variants[nextIndex];
      if (next) {
        onChange(next.key);
      }
    },
    [currentIndex, onChange],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "ArrowLeft") {
        cycle(-1);
      }
      if (event.key === "ArrowRight") {
        cycle(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cycle]);

  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const selected = variants[currentIndex] ?? { key: "A", label: "Briefing desk" };

  if (collapsed) {
    return (
      <aside className={styles.switcher} data-collapsed aria-label="Prototype variants">
        <button
          className={styles.showControls}
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Show prototype controls"
        >
          <VariantIcon />
          <strong>{selected.key}</strong>
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.switcher} aria-label="Prototype variants">
      <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant">
        <Arrow direction="left" />
      </button>
      <button
        className={styles.labelButton}
        type="button"
        onClick={() => setCollapsed(true)}
        aria-label="Hide prototype controls"
        aria-live="polite"
      >
        <small>Throwaway prototype</small>
        <strong>
          {selected.key} · {selected.label}
        </strong>
      </button>
      <button type="button" onClick={() => cycle(1)} aria-label="Next variant">
        <Arrow direction="right" />
      </button>
    </aside>
  );
}

function VariantIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="3" y="3" width="5" height="5" rx="1" />
      <rect x="12" y="3" width="5" height="5" rx="1" />
      <rect x="3" y="12" width="5" height="5" rx="1" />
      <rect x="12" y="12" width="5" height="5" rx="1" />
    </svg>
  );
}

function Arrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d={direction === "left" ? "M12.5 4.5 7 10l5.5 5.5" : "M7.5 4.5 13 10l-5.5 5.5"}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
