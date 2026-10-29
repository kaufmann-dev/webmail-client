CREATE TYPE "public"."invitation_response_kind" AS ENUM('accepted', 'tentative', 'declined');--> statement-breakpoint
CREATE TABLE "invitation_response" (
	"account_id" text NOT NULL,
	"uid" text NOT NULL,
	"sequence" integer NOT NULL,
	"response" "invitation_response_kind" NOT NULL,
	"responded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_response_account_id_uid_pk" PRIMARY KEY("account_id","uid")
);
--> statement-breakpoint
ALTER TABLE "invitation_response" ADD CONSTRAINT "invitation_response_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;