export function parsePlaywrightBaseUrl(value: string): URL {
  if (!URL.canParse(value)) {
    throw new TypeError("PLAYWRIGHT_BASE_URL must be a valid absolute URL.");
  }

  return new URL(value);
}
