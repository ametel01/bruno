CREATE TABLE "founder_identity_recovery_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_digest" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_identity_recovery_credentials_digest_check" CHECK ("founder_identity_recovery_credentials"."credential_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_identity_recovery_credentials_window_check" CHECK ("founder_identity_recovery_credentials"."expires_at" > "founder_identity_recovery_credentials"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "founder_identity_recovery_credentials" ADD CONSTRAINT "founder_identity_recovery_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_identity_recovery_credentials_user_idx" ON "founder_identity_recovery_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_identity_recovery_credentials_digest_idx" ON "founder_identity_recovery_credentials" USING btree ("credential_digest");