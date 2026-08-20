export type FounderTimezoneOption = readonly [value: string, label: string];

export const DEFAULT_FOUNDER_TIMEZONE_OPTIONS: ReadonlyArray<FounderTimezoneOption> = [
  ["UTC", "UTC"],
  ["Asia/Manila", "Manila (Asia)"],
  ["America/Los_Angeles", "Los Angeles (America)"],
  ["America/New_York", "New York (America)"],
];

export function buildFounderTimezoneOptions(): ReadonlyArray<FounderTimezoneOption> {
  const values =
    typeof Intl.supportedValuesOf === "function"
      ? ["UTC", ...Intl.supportedValuesOf("timeZone")]
      : DEFAULT_FOUNDER_TIMEZONE_OPTIONS.map(([value]) => value);

  return [...new Set(values)].map((value) => [value, friendlyTimezoneLabel(value)] as const);
}

function friendlyTimezoneLabel(value: string): string {
  const [region, ...placeParts] = value.split("/");
  const place = placeParts.join(" / ").replaceAll("_", " ");
  const readableRegion = (region ?? "Other").replaceAll("_", " ");
  return place ? `${place} (${readableRegion})` : readableRegion;
}
