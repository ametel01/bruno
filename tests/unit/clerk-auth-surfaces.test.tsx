import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signedIn: true,
  signInProps: undefined as Record<string, unknown> | undefined,
  signOutRedirectUrl: undefined as string | undefined,
  signUpProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkDegraded: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-auth-state": "degraded" }, children),
  ClerkFailed: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-auth-state": "failed" }, children),
  ClerkLoaded: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-auth-state": "loaded" }, children),
  ClerkLoading: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-auth-state": "loading" }, children),
  Show: ({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) =>
    mocks.signedIn ? children : fallback,
  SignIn: (props: Record<string, unknown>) => {
    mocks.signInProps = props;
    return createElement("div", { "aria-label": "Clerk sign-in widget" });
  },
  SignOutButton: ({
    children,
    redirectUrl,
  }: {
    children: React.ReactNode;
    redirectUrl?: string;
  }) => {
    mocks.signOutRedirectUrl = redirectUrl;
    return children;
  },
  SignUp: (props: Record<string, unknown>) => {
    mocks.signUpProps = props;
    return createElement("div", { "aria-label": "Clerk sign-up widget" });
  },
  UserButton: () => createElement("button", { type: "button" }, "Mock current user"),
}));

import {
  AccountControls,
  SignInSurface,
  SignUpSurface,
} from "@/app/_components/clerk-auth-surfaces";

describe("Clerk authentication surfaces", () => {
  beforeEach(() => {
    mocks.signedIn = true;
    mocks.signInProps = undefined;
    mocks.signOutRedirectUrl = undefined;
    mocks.signUpProps = undefined;
  });

  it("renders accessible loading, failure, degraded, current-user, and sign-out states", () => {
    const html = renderToStaticMarkup(createElement(AccountControls));

    expect(html).toContain('aria-label="Account controls"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading account controls");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Account controls could not be loaded.");
    expect(html).toContain("Account controls are temporarily limited.");
    expect(html).toContain("Current user");
    expect(html).toContain("Mock current user");
    expect(html).toContain("Sign out");
    expect(mocks.signOutRedirectUrl).toBe("/sign-in");
  });

  it("renders explicit sign-in and registration links for a signed-out client state", () => {
    mocks.signedIn = false;

    const html = renderToStaticMarkup(createElement(AccountControls));

    expect(html).toContain('href="/sign-in"');
    expect(html).toContain("Sign in");
    expect(html).toContain('href="/sign-up"');
    expect(html).toContain("Create account");
  });

  it.each([
    [
      SignInSurface,
      "Sign in to bruno",
      "Clerk sign-in widget",
      () => mocks.signInProps,
      {
        fallbackRedirectUrl: "/dashboard",
        path: "/sign-in",
        routing: "path",
        signUpUrl: "/sign-up",
      },
    ],
    [
      SignUpSurface,
      "Create your bruno account",
      "Clerk sign-up widget",
      () => mocks.signUpProps,
      {
        fallbackRedirectUrl: "/dashboard",
        path: "/sign-up",
        routing: "path",
        signInUrl: "/sign-in",
      },
    ],
  ] as const)("renders %s with deterministic routing, loading, and error states", (Surface, heading, widgetLabel, readProps, expectedProps) => {
    const html = renderToStaticMarkup(createElement(Surface));

    expect(html).toContain(heading);
    expect(html).toContain("Loading authentication");
    expect(html).toContain("Authentication could not be loaded. Try again shortly.");
    expect(html).toContain("Authentication is temporarily limited.");
    expect(html).toContain(`aria-label="${widgetLabel}"`);
    expect(readProps()).toEqual(expectedProps);
  });
});
