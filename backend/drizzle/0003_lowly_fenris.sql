ALTER TABLE "users" ADD COLUMN "username" varchar(15);--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" USING btree (lower("username"));