-- Jungle Quest shared-state schema for Supabase
-- Run this once in Supabase Dashboard > SQL Editor.

create table if not exists public.app_state (
  id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users(id)
);

-- Explicit allowlist of users who may administer the leaderboard.
create table if not exists public.leaderboard_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.app_state enable row level security;
alter table public.leaderboard_admins enable row level security;

-- Everyone visiting the GitHub Pages site may read the leaderboard.
drop policy if exists "Public can view leaderboard" on public.app_state;
create policy "Public can view leaderboard"
on public.app_state
for select
to anon, authenticated
using (true);

-- Only authenticated users explicitly added to leaderboard_admins may update it.
drop policy if exists "Allowlisted admins can update leaderboard" on public.app_state;
create policy "Allowlisted admins can update leaderboard"
on public.app_state
for update
to authenticated
using (
  exists (
    select 1 from public.leaderboard_admins a
    where a.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.leaderboard_admins a
    where a.user_id = auth.uid()
  )
);

grant select on public.app_state to anon;
grant select, update on public.app_state to authenticated;

-- The app itself never needs direct access to the admin allowlist.
revoke all on public.leaderboard_admins from anon, authenticated;

insert into public.app_state (id, state)
values (
  1,
  '{
    "teams": [
      {"id":1,"name":"Tigers","color":"#c6532f","icon":"🐯","score":0,"covered":false},
      {"id":2,"name":"Jaguars","color":"#4b368f","icon":"🐆","score":0,"covered":false},
      {"id":3,"name":"Parrots","color":"#137f6c","icon":"🦜","score":0,"covered":false},
      {"id":4,"name":"Gorillas","color":"#38628a","icon":"🦍","score":0,"covered":false},
      {"id":5,"name":"Lizard","color":"#547f2b","icon":"🦎","score":0,"covered":false},
      {"id":6,"name":"Elephants","color":"#9b5d2e","icon":"🐘","score":0,"covered":false}
    ],
    "timer":{"duration":1200,"remaining":1200,"running":false,"hidden":false,"endAt":null},
    "rotation":"Half 1",
    "rankingsHidden":false,
    "history":[],
    "soundEnabled":true,
    "lastLeaderId":null
  }'::jsonb
)
on conflict (id) do nothing;

-- Enable Realtime for this table only if it is not already in the publication.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end $$;

-- AFTER creating your admin user in Authentication > Users, run this separately,
-- replacing the email address with your admin account:
--
-- insert into public.leaderboard_admins (user_id)
-- select id from auth.users where email = 'YOUR_ADMIN_EMAIL@example.com'
-- on conflict (user_id) do nothing;
