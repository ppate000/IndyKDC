-- JYOTARA SUPABASE SETUP
-- Run this entire file once in Supabase > SQL Editor.
--
-- IMPORTANT:
-- After running it, create your admin user in Authentication > Users.
-- Then add that user's EMAIL to public.leaderboard_admins.

create table if not exists public.leaderboard_state (
  id integer primary key check (id = 1),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.leaderboard_state (id, state)
values (
  1,
  '{
    "teams": [
      {"id":"team1","name":"Team 1","score":0},
      {"id":"team2","name":"Team 2","score":0},
      {"id":"team3","name":"Team 3","score":0},
      {"id":"team4","name":"Team 4","score":0},
      {"id":"team5","name":"Team 5","score":0},
      {"id":"team6","name":"Team 6","score":0}
    ],
    "standingsHidden": false,
    "revealedPlacements": [],
    "timerVisible": false,
    "timerEndsAt": null
  }'::jsonb
)
on conflict (id) do nothing;

create table if not exists public.leaderboard_admins (
  email text primary key
);

alter table public.leaderboard_state enable row level security;
alter table public.leaderboard_admins enable row level security;

drop policy if exists "Anyone can read leaderboard" on public.leaderboard_state;
create policy "Anyone can read leaderboard"
on public.leaderboard_state
for select
to anon, authenticated
using (true);

drop policy if exists "Admins can update leaderboard" on public.leaderboard_state;
create policy "Admins can update leaderboard"
on public.leaderboard_state
for update
to authenticated
using (
  exists (
    select 1
    from public.leaderboard_admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
)
with check (
  exists (
    select 1
    from public.leaderboard_admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

drop policy if exists "Admin can read own allowlist row" on public.leaderboard_admins;
create policy "Admin can read own allowlist row"
on public.leaderboard_admins
for select
to authenticated
using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Allow Realtime UPDATE events for this table.
alter publication supabase_realtime add table public.leaderboard_state;

-- AFTER you create the admin user, run this line separately with your real email:
-- insert into public.leaderboard_admins(email) values ('YOUR_ADMIN_EMAIL@example.com')
-- on conflict (email) do nothing;
