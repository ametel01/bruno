import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { SignInSurface } from "@/app/_components/clerk-auth-surfaces";
import { resolveClerkTransition } from "@/src/auth/clerk-transition";

export default function SignInPage() {
  if (resolveClerkTransition(process.env).mode !== "clerk") {
    return <AuthConfigurationUnavailable />;
  }

  return <SignInSurface />;
}
