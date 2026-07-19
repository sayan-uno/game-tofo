CREATE TABLE "dm_clears" (
	"user_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_clears_user_id_partner_id_pk" PRIMARY KEY("user_id","partner_id")
);
--> statement-breakpoint
ALTER TABLE "dm_clears" ADD CONSTRAINT "dm_clears_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_clears" ADD CONSTRAINT "dm_clears_partner_id_users_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;