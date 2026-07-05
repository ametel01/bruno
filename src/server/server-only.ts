export function assertServerOnlyModule(moduleName: string): void {
  if (typeof window !== "undefined") {
    throw new Error(`${moduleName} is server-only and must not be imported by client components.`);
  }
}
