CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_blocked_key" UNIQUE("blocker_id","blocked_id"),
	CONSTRAINT "blocks_check" CHECK (blocker_id <> blocked_id)
);
--> statement-breakpoint
CREATE TABLE "dm_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"body" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"lobby_id" text NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" varchar(500) NOT NULL,
	"visible_to" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blocks_blocked" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "idx_dm_sender_recipient" ON "dm_messages" USING btree ("sender_id","recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dm_recipient_sender" ON "dm_messages" USING btree ("recipient_id","sender_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dm_created" ON "dm_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_team_session" ON "team_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_team_created" ON "team_messages" USING btree ("created_at");