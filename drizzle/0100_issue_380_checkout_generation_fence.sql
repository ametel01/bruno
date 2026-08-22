ALTER TABLE "founder_checkout_correlations" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
WITH "ranked_checkout_correlations" AS (
	SELECT "id", row_number() OVER (PARTITION BY "user_id" ORDER BY "created_at", "id")::integer AS "generation"
	FROM "founder_checkout_correlations"
)
UPDATE "founder_checkout_correlations" AS "checkout"
SET "generation" = "ranked"."generation"
FROM "ranked_checkout_correlations" AS "ranked"
WHERE "checkout"."id" = "ranked"."id";--> statement-breakpoint
CREATE UNIQUE INDEX "founder_checkout_correlations_user_generation_idx" ON "founder_checkout_correlations" USING btree ("user_id","generation");--> statement-breakpoint
ALTER TABLE "founder_checkout_correlations" ADD CONSTRAINT "founder_checkout_correlations_generation_check" CHECK ("founder_checkout_correlations"."generation" >= 1);
