CREATE TABLE "mailbox_aliases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"mailbox_id" varchar(36) NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"email" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_aliases_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "mailbox_aliases" ADD CONSTRAINT "mailbox_aliases_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_aliases" ADD CONSTRAINT "mailbox_aliases_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mailbox_aliases_mailbox_id" ON "mailbox_aliases" USING btree ("mailbox_id");