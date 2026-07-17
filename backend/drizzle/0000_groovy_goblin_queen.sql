CREATE TABLE "friendships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"addressee_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "friendships_requester_id_addressee_id_key" UNIQUE("requester_id","addressee_id"),
	CONSTRAINT "friendships_status_check" CHECK (status IN ('pending', 'accepted')),
	CONSTRAINT "friendships_check" CHECK (requester_id <> addressee_id)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uid" varchar(12) NOT NULL,
	"google_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_uid_key" UNIQUE("uid"),
	CONSTRAINT "users_google_id_key" UNIQUE("google_id"),
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addressee_id_users_id_fk" FOREIGN KEY ("addressee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_friendships_addressee" ON "friendships" USING btree ("addressee_id","status");--> statement-breakpoint
CREATE INDEX "idx_friendships_requester" ON "friendships" USING btree ("requester_id","status");--> statement-breakpoint
CREATE INDEX "idx_users_uid" ON "users" USING btree ("uid");