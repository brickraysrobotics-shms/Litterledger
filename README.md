# Litter Ledger Server

Express + SQLite backend for the Litter Ledger app. Reporters submit a photo
+ suggested category; **you review each submission and assign the points**
before it counts toward the leaderboard. Photos are resized, recompressed to
JPEG, and stored as BLOBs in a local `litter-ledger.db` file — no cloud
storage account required.

## Run it

```bash
npm install
npm start
```

Console output on first run will show something like:

```
Litter Ledger server running at http://localhost:3000
Admin password (saved to .admin-password): 33j9Mn2vMrI4
Review queue: http://localhost:3000/admin.html
```

- **Reporters** use **http://localhost:3000**
- **You** use **http://localhost:3000/admin.html** with that password

To set your own password instead of the auto-generated one, set
`ADMIN_PASSWORD` in the environment before starting:

```bash
ADMIN_PASSWORD=yourpassword npm start
```

## How it works

1. A reporter submits a photo, picks a category (just a hint for you), and
   optionally notes the spot / whether they removed it. This lands as a
   **pending** entry — no points yet, nothing on the leaderboard.
2. You open `/admin.html`, enter the password, and see the queue of pending
   photos with the reporter's suggested category pre-filling a points field.
3. You type the points you're actually awarding and hit **Approve** (or
   **Reject** if it doesn't count). Approving is what updates the user's
   total and makes the entry show up in the public feed/leaderboard.

## What's here

- `server.js` — the API (Express + `better-sqlite3` + `multer` + `sharp`)
- `public/index.html` — the reporter-facing app
- `public/admin.html` — the password-gated review queue
- `litter-ledger.db` — created automatically on first run (git-ignored)
- `.admin-password` — auto-generated password, only created if you didn't
  set `ADMIN_PASSWORD` yourself (git-ignored)

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/categories` | Suggested categories (label only, no points) |
| POST | `/api/entries` | Submit a find (`multipart/form-data`: `username`, `categoryId`, `removed`, `spot`, `lat`, `lng`, `photo`) → status `pending` |
| GET | `/api/entries?limit=25` | Public feed — **approved entries only** |
| GET | `/api/entries/map` | All approved entries that have coordinates — used to plot the pollution map |
| GET | `/api/photos/:id` | Raw photo bytes |
| GET | `/api/leaderboard` | Users sorted by points — reflects approved entries only |
| GET | `/api/users/:username` | One user's totals, rank, and count of their still-pending submissions |
| POST | `/api/admin/login` | Check a password (used by the admin page) |
| GET | `/api/admin/pending` | *(requires `x-admin-key` header)* Queue of pending entries with photos and coordinates |
| POST | `/api/admin/entries/:id/review` | *(requires `x-admin-key` header)* Body: `{decision: "approved"|"rejected", points, note}` |

## Setting up the Google Maps API key (for the location picker & pollution map)

Both `public/index.html` (the map/pin picker reporters use) and
`public/admin.html` (the pollution hotspot map) load Google Maps using a key
you configure in `public/config.js`. Without a key, both still work — the
map areas just show a "map unavailable" message and submissions go through
without coordinates.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (or use an existing one)
2. Enable billing on the project — Google requires a billing-enabled account
   to issue Maps keys, but there's a generous free monthly credit, and an
   app this size is very unlikely to exceed it
3. Go to **APIs & Services → Library**, search for **"Maps JavaScript API"**,
   click **Enable**
4. Go to **APIs & Services → Credentials → Create Credentials → API key**
5. **Restrict the key** (click into it after creating): under "Application
   restrictions" limit it to your domains (e.g. `yourdomain.com/*`,
   `localhost/*` for testing); under "API restrictions" limit it to just
   "Maps JavaScript API". This stops anyone who finds the key in your
   frontend code from using it for other Google services on your bill.
6. Paste the key into `public/config.js`:
   ```js
   window.GOOGLE_MAPS_API_KEY = 'your-actual-key-here';
   ```

The native app project (`litter-ledger-app`) has its own `www/config.js`
with the same variable — update both if you're running both.

## Notes / things you may want to change next

- **No reporter accounts.** Anyone can submit as any username — there's no
  password on the reporter side, so names can be impersonated or squatted.
  The admin side does have a password.
- **Single shared admin password**, not per-admin accounts. Fine for one or
  two people; if you'll have a review team, worth moving to real accounts.
- **Local file storage of the DB.** `litter-ledger.db` lives on whatever
  machine runs the server. Fine for one deployment target; if you move to
  something like Render/Fly/Railway with ephemeral disks, you'll want a
  persistent volume or a hosted Postgres instead of SQLite-on-disk.
- **No pagination on `/api/leaderboard`** or the admin queue. Fine at small
  scale; will want a `LIMIT`/cursor once volume grows.
- **CORS is wide open** (`cors()` with defaults, i.e. `*`). Tighten this to
  your actual frontend origin before putting this on the public internet.
