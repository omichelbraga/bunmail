CREATE TABLE "mailboxes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"email" varchar(255) NOT NULL,
	"local_part" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"quota_bytes" bigint DEFAULT 1073741824 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mailboxes_domain_id" ON "mailboxes" USING btree ("domain_id");