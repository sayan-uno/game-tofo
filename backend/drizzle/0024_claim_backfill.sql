-- Nobody loses what they are already wearing.
--
-- Owning a collection item used to be implied: free meant everybody had it, so
-- there was nothing to record. Claiming makes it explicit — you own what you
-- asked for — and equipping now requires a claim. Without this, every account
-- that exists would be wearing something it does not own, and `canEquip` would
-- refuse the character already on their pedestal.
--
-- So: one claim per player for whatever they have on, marked `legacy` so the
-- console can tell "was already wearing this" apart from "chose it".
--
-- ON CONFLICT DO NOTHING makes it safe to run twice, and it deliberately does
-- NOT hand out the rest of the catalog: everything else is claimed the ordinary
-- way, one tap, and free things still cost nothing.
insert into user_items (user_id, item_id, currency, price_paid, source)
select u.id, u.equipped_character, null, 0, 'legacy'
  from users u
 where u.equipped_character is not null
on conflict (user_id, item_id) do nothing;
--> statement-breakpoint
insert into user_items (user_id, item_id, currency, price_paid, source)
select u.id, u.equipped_weapon, null, 0, 'legacy'
  from users u
 where u.equipped_weapon is not null
on conflict (user_id, item_id) do nothing;
