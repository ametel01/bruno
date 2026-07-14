"use client";

import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  Show,
  SignIn,
  SignOutButton,
  SignUp,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";

export function AccountControls() {
  return (
    <fieldset className="account-controls" aria-label="Account controls">
      <ClerkLoading>
        <p className="auth-state-message" role="status" aria-live="polite">
          Loading account controls…
        </p>
      </ClerkLoading>
      <ClerkFailed>
        <p className="auth-state-message" role="alert">
          Account controls could not be loaded.
        </p>
      </ClerkFailed>
      <ClerkDegraded>
        <p className="auth-state-message" role="status">
          Account controls are temporarily limited.
        </p>
      </ClerkDegraded>
      <ClerkLoaded>
        <Show
          when="signed-in"
          fallback={
            <div className="signed-out-links">
              <Link href="/sign-in">Sign in</Link>
              <Link href="/sign-up">Create account</Link>
            </div>
          }
        >
          <span className="account-label">Current user</span>
          <UserButton showName />
          <SignOutButton redirectUrl="/sign-in">
            <button className="secondary-button account-sign-out" type="button">
              Sign out
            </button>
          </SignOutButton>
        </Show>
      </ClerkLoaded>
    </fieldset>
  );
}

export function SignInSurface() {
  return (
    <AuthSurface
      description="Use your plingpling account to continue to the operator dashboard."
      title="Sign in to plingpling"
    >
      <SignIn
        fallbackRedirectUrl="/dashboard"
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
      />
    </AuthSurface>
  );
}

export function SignUpSurface() {
  return (
    <AuthSurface
      description="Create a plingpling account to start using the managed agent control plane."
      title="Create your plingpling account"
    >
      <SignUp
        fallbackRedirectUrl="/dashboard"
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
      />
    </AuthSurface>
  );
}

function AuthSurface({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-page-title">
        <div className="auth-copy">
          <Link className="brand-mark" href="/" aria-label="plingpling home">
            PP
          </Link>
          <p className="eyebrow">plingpling account</p>
          <h1 id="auth-page-title">{title}</h1>
          <p>{description}</p>
        </div>
        <div className="auth-widget">
          <ClerkLoading>
            <p className="auth-state-message" role="status" aria-live="polite">
              Loading authentication…
            </p>
          </ClerkLoading>
          <ClerkFailed>
            <p className="auth-state-message" role="alert">
              Authentication could not be loaded. Try again shortly.
            </p>
          </ClerkFailed>
          <ClerkDegraded>
            <p className="auth-state-message" role="status">
              Authentication is temporarily limited.
            </p>
          </ClerkDegraded>
          <ClerkLoaded>{children}</ClerkLoaded>
        </div>
      </section>
    </main>
  );
}
