import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

setup.describe.configure({ mode: "serial" });

setup("configure the Clerk testing token", async () => {
  await clerkSetup();
});
