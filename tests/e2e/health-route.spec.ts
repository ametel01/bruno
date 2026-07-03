import { expect, test } from "@playwright/test";

test("health route reports a reachable database", async ({ request }) => {
  const response = await request.get("/health");
  const body = await response.json();

  expect(response.status()).toBe(200);
  expect(body).toMatchObject({
    status: "ok",
    database: "reachable",
  });
  expect(Date.parse(body.timestamp)).not.toBeNaN();
  expect(JSON.stringify(body)).not.toContain("postgres://");
});
