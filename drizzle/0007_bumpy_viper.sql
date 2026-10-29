CREATE TABLE "sent_meeting" (
	"account_id" text NOT NULL,
	"uid" text NOT NULL,
	"sequence" integer NOT NULL,
	"message_id" text NOT NULL,
	"canceled" boolean NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sent_meeting_account_id_uid_pk" PRIMARY KEY("account_id","uid")
);
--> statement-breakpoint
ALTER TABLE "sent_meeting" ADD CONSTRAINT "sent_meeting_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;