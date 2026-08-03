export type ForegroundPollingWindow = {
  accumulatedMs: number;
  activeStartedAt: number | null;
};

export function startForegroundPollingWindow(now: number): ForegroundPollingWindow {
  return { accumulatedMs: 0, activeStartedAt: now };
}

export function pauseForegroundPollingWindow(
  window: ForegroundPollingWindow,
  now: number,
): ForegroundPollingWindow {
  if (window.activeStartedAt === null) {
    return window;
  }

  return {
    accumulatedMs: window.accumulatedMs + Math.max(0, now - window.activeStartedAt),
    activeStartedAt: null,
  };
}

export function resumeForegroundPollingWindow(
  window: ForegroundPollingWindow,
  now: number,
  options: { reset?: boolean } = {},
): ForegroundPollingWindow {
  if (options.reset) {
    return startForegroundPollingWindow(now);
  }

  if (window.activeStartedAt !== null) {
    return window;
  }

  return { ...window, activeStartedAt: now };
}

export function foregroundPollingElapsedMs(window: ForegroundPollingWindow, now: number): number {
  const activeElapsed =
    window.activeStartedAt === null ? 0 : Math.max(0, now - window.activeStartedAt);

  return window.accumulatedMs + activeElapsed;
}
