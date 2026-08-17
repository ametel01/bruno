import Link from "next/link";
import { BrunoLogo } from "@/app/_components/bruno-logo";

export function AuthConfigurationUnavailable() {
  return (
    <main className="auth-page">
      <section className="auth-card compact-auth-card" aria-labelledby="auth-unavailable-title">
        <div className="auth-copy">
          <Link className="brand-mark" href="/" aria-label="Bruno.Ai home">
            <BrunoLogo className="auth-bruno-logo" compact />
          </Link>
          <p className="eyebrow">Bruno.Ai account</p>
          <h1 id="auth-unavailable-title">Authentication is not available</h1>
          <p role="alert">
            Clerk sign-in is not enabled in this environment. Operator access remains active.
          </p>
        </div>
      </section>
    </main>
  );
}
