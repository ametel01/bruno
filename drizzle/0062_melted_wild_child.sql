ALTER TABLE "operator_conversations" DROP CONSTRAINT "operator_conversations_operator_id_operators_id_fk";
--> statement-breakpoint
ALTER TABLE "operator_conversations" ADD CONSTRAINT "operator_conversations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;