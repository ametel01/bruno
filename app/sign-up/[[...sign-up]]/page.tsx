import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { SignUpSurface } from "@/app/_components/clerk-auth-surfaces";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";

export default async function SignUpPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (resolveAuthMode(process.env).mode !== "clerk") {
    return <AuthConfigurationUnavailable />;
  }

  const values = await searchParams;
  return <SignUpSurface identityRecovery={values.continue === "identity-recovery"} />;
}
