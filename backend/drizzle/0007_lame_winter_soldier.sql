CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_id" uuid,
	"admin_email" text NOT NULL,
	"action" varchar(60) NOT NULL,
	"target_type" varchar(30),
	"target_id" text,
	"ip" "inet",
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "admin_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"refresh_hash" char(64) NOT NULL,
	"ip" "inet",
	"ua" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_sessions_refresh_key" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" varchar(20) DEFAULT 'moderator' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"totp_secret_enc" text,
	"totp_activated_at" timestamp with time zone,
	"totp_last_step" bigint,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "admin_users_email_key" UNIQUE("email"),
	CONSTRAINT "admin_users_role_check" CHECK (role IN ('owner','admin','moderator','support','analyst')),
	CONSTRAINT "admin_users_status_check" CHECK (status IN ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" varchar(40) NOT NULL,
	"user_id" uuid,
	"uid" varchar(12),
	"ip" "inet",
	"ip_country" char(2),
	"ua" text,
	"device_hash" char(32),
	"match_key" text,
	"game_id" varchar(40),
	"lobby_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_replays" (
	"match_key" text PRIMARY KEY NOT NULL,
	"game_id" varchar(40) NOT NULL,
	"r2_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"tier" varchar(12) DEFAULT 'standard' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_matches" integer DEFAULT 20 NOT NULL,
	"matches_used" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "recording_targets_kind_check" CHECK (kind IN ('voice','replay-extended'))
);
--> statement-breakpoint
CREATE TABLE "sanctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "sanctions_type_check" CHECK (type IN ('ban','match','voice','chat','shadow-chat'))
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"user_id" uuid NOT NULL,
	"device_hash" char(32) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"ua" text,
	CONSTRAINT "user_devices_user_id_device_hash_pk" PRIMARY KEY("user_id","device_hash")
);
--> statement-breakpoint
CREATE TABLE "voice_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_key" text NOT NULL,
	"user_id" uuid,
	"uid" varchar(12) NOT NULL,
	"r2_key" text NOT NULL,
	"egress_id" text,
	"status" varchar(16) DEFAULT 'starting' NOT NULL,
	"bytes" bigint,
	"duration_sec" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "voice_recordings_status_check" CHECK (status IN ('starting','active','complete','failed'))
);
--> statement-breakpoint
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_targets" ADD CONSTRAINT "recording_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_targets" ADD CONSTRAINT "recording_targets_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_revoked_by_admin_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_audit_at" ON "admin_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "idx_admin_audit_admin" ON "admin_audit" USING btree ("admin_id","at");--> statement-breakpoint
CREATE INDEX "idx_admin_audit_target" ON "admin_audit" USING btree ("target_type","target_id","at");--> statement-breakpoint
CREATE INDEX "idx_admin_audit_action" ON "admin_audit" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "idx_admin_recovery_admin" ON "admin_recovery_codes" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "idx_admin_sessions_admin" ON "admin_sessions" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_lower_key" ON "admin_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "idx_event_log_at" ON "event_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "idx_event_log_user" ON "event_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "idx_event_log_type" ON "event_log" USING btree ("type","at");--> statement-breakpoint
CREATE INDEX "idx_event_log_ip" ON "event_log" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "idx_event_log_device" ON "event_log" USING btree ("device_hash","at");--> statement-breakpoint
CREATE INDEX "idx_match_replays_expiry" ON "match_replays" USING btree ("tier","expires_at");--> statement-breakpoint
CREATE INDEX "idx_match_replays_created" ON "match_replays" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_recording_targets_user" ON "recording_targets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sanctions_user" ON "sanctions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_sanctions_expiry" ON "sanctions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_user_devices_hash" ON "user_devices" USING btree ("device_hash");--> statement-breakpoint
CREATE INDEX "idx_voice_recordings_match" ON "voice_recordings" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "idx_voice_recordings_user" ON "voice_recordings" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_voice_recordings_expiry" ON "voice_recordings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_users_created" ON "users" USING btree ("created_at");