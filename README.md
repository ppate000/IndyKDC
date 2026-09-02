# Jyotara Live Leaderboard

A static GitHub Pages site with Supabase-backed live synchronization.

## Files

- `index.html` — page structure and Supabase config
- `styles.css` — styling
- `app.js` — leaderboard, timer, admin controls, realtime sync
- `space-bg.gif` — your supplied animated space background
- `supabase-setup.sql` — database, RLS policies, and realtime setup

## Features

- 6 teams
- Live points across all connected devices
- Small celebration when a different team takes first place
- Admin login using Supabase Auth
- Admin-only point controls
- Hide all standings, including first place
- Reveal hidden placements one at a time by clicking them while logged in as admin
- Live synchronized timer
- Timer remains at `00:00` with no sound/effect until hidden or restarted

## Important

Only put the Supabase **anon/public key** in `index.html`. Never put a Supabase service-role key in a GitHub Pages site.
