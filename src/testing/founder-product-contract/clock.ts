export const FOUNDER_PRODUCT_CONTRACT_DEFAULT_TIME = "2026-01-01T00:00:00.000Z" as const;

export type FounderProductContractClock = {
  now(): Date;
  set(value: Date | string): Date;
  advance(milliseconds: number): Date;
};

export function createFounderProductContractClock(
  initial: Date | string = FOUNDER_PRODUCT_CONTRACT_DEFAULT_TIME,
): FounderProductContractClock {
  let current = parseInstant(initial);

  return {
    now: () => new Date(current.getTime()),
    set: (value) => {
      current = parseInstant(value);
      return new Date(current.getTime());
    },
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds)) {
        throw new Error("Founder Product Contract clock advance must be finite.");
      }
      current = new Date(current.getTime() + milliseconds);
      return new Date(current.getTime());
    },
  };
}

export function parseFounderProductContractInstant(value: Date | string): Date {
  return parseInstant(value);
}

function parseInstant(value: Date | string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error("Founder Product Contract clock value must be a valid instant.");
  }
  return parsed;
}
