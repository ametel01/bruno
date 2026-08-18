ALTER TABLE "operator_action_previews" DROP CONSTRAINT "operator_action_previews_operator_id_operators_id_fk";
--> statement-breakpoint
ALTER TABLE "operator_action_previews" ADD CONSTRAINT "operator_action_previews_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;