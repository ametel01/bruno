ALTER TABLE "operator_ai_connections" ADD COLUMN "billing_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "privacy_accepted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "retention_bounded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "third_party_permission_granted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "credential_healthy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "reconnect_supported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "production_use_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD COLUMN "processing_consent_active" boolean DEFAULT false NOT NULL;