import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { SignUpSurface } from "@/app/_components/clerk-auth-surfaces";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";

export default function SignUpPage() {
  if (resolveAuthMode(process.env).mode !== "clerk") {
    return <AuthConfigurationUnavailable />;
  }

  return <SignUpSurface />;
}
