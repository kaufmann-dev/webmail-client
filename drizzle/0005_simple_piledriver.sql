CREATE TABLE "mcp_message_ref" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"locator" text NOT NULL,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_message_ref_locator_uq" UNIQUE("user_id","locator")
);
--> statement-breakpoint
ALTER TABLE "mcp_message_ref" ADD CONSTRAINT "mcp_message_ref_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_message_ref" ADD CONSTRAINT "mcp_message_ref_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;