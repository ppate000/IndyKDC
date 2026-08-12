# Jungle Quest Leaderboard — Live GitHub Pages Version

This version keeps the static GitHub Pages frontend but stores the leaderboard in Supabase/PostgreSQL. Score and state changes are pushed to every open browser through Supabase Realtime.

## Files

- `index.html` — page UI
- `styles.css` — styling and animations
- `app.js` — leaderboard logic, Supabase reads/writes, Realtime subscription, and admin auth
- `config.js` — your Supabase Project URL and **publishable** key
- `schema.sql` — one-time database/RLS/Realtime setup

## 1. Create a Supabase project

Create a project at Supabase, then open **SQL Editor** and run all of `schema.sql`.

## 2. Create and allowlist the admin

In Supabase Dashboard, open **Authentication > Users** and create the email/password user who should edit scores.

Then run this in SQL Editor, replacing the email:

```sql
insert into public.leaderboard_admins (user_id)
select id from auth.users where email = 'YOUR_ADMIN_EMAIL@example.com'
on conflict (user_id) do nothing;
```

Only users in `leaderboard_admins` can update the shared state. Anonymous visitors can only read it.

## 3. Configure the frontend

Open `config.js` and replace:

```js
supabaseUrl: 'YOUR_SUPABASE_PROJECT_URL',
supabasePublishableKey: 'YOUR_SUPABASE_PUBLISHABLE_KEY'
```

Use the Project URL and **Publishable key** from the Supabase Connect/API Keys area.

**Never put a secret key or service_role key in `config.js`.** GitHub Pages is public frontend code.

## 4. Publish to GitHub Pages

Put these files at the root of your repository, push them to GitHub, then enable Pages under:

**Repository Settings > Pages > Deploy from a branch > main / root**

## How it works

1. Any viewer loads the current `app_state` row from Supabase.
2. Viewers subscribe to Realtime updates for that row.
3. An allowlisted admin signs in from the Admin button.
4. Admin changes update PostgreSQL.
5. Supabase broadcasts the new state to every open page.

Scores, team settings, rankings visibility, curtains, rotation, history, and timer state are shared. The timer uses a shared `endAt` timestamp so every browser calculates the same remaining time without writing once per second.

## Local fallback

Until `config.js` is configured, the site still opens in local-only mode using browser storage. In local mode, changes are not shared across devices.
