import { validateRequiredEnv } from "@/src/env/validation";

export function getServerEnv(input = process.env) {
  return validateRequiredEnv(input);
}
