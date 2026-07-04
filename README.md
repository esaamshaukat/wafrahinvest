# Wafrah Public

Multi-user version of Wafrah. This project is intentionally separate from `D:/ClaudeProject/wafrah`.

## Current MVP

- Username/password sign up and sign in using Firebase Auth internally.
- Per-user Firestore storage under `users/{uid}`.
- Portfolio onboarding: Aggressive Growth, Balanced, Income Focused, Capital Preservation.
- Private ledger, holdings, overview KPIs, performance chart, CSV export.
- Admin-only global fund catalog editor.
- Firestore rules included in `firestore.rules` to enforce user isolation and admin writes.

## Important

Deploy `firestore.rules` before using this with real users. UI hiding is not security; Firestore rules are the security boundary.


## Live NAV Fetching

The public app now uses the same Firestore NAV document shape as the original Wafrah app.

The NAV writer is `fetch_navs.py`. Run it with Firebase Admin credentials for the **wafrah2** project, not the old private project. It writes:

- `meezan/navs`
  - `navs`: object map of fund name to NAV
  - `success`: boolean
  - `updatedAt`: ISO timestamp when NAVs were updated
  - `lastChecked`: ISO timestamp for every workflow run
- `meezan/portfolio`
  - `navHistory`: object keyed by ISO date, then fund name
- `meezan/fyHistory`
  - fiscal-year high/low NAV ranges

Supported credentials are the same as the original script:

- `FIREBASE_SERVICE_ACCOUNT`: full service-account JSON, or
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, or
- local `serviceAccount.json`

For GitHub Actions, create secrets from the new Firebase project service account. The app-side `Fetch Latest NAVs` button reads `meezan/navs`; if the current user is admin, it also saves those prices into `public/fundCatalog` so all users see the latest NAVs.

After changing rules, deploy `firestore.rules` so signed-in users can read `/meezan/*`.


## Running NAV Scripts Locally

Install dependencies once:

```powershell
cd D:\ClaudeProject\Wafrah_Public
python -m pip install requests firebase-admin beautifulsoup4 pandas lxml
```

Use a Firebase service account for the `wafrah2` project. Either save it as `serviceAccount.json` in this folder, or set environment variables:

```powershell
$env:FIREBASE_SERVICE_ACCOUNT = Get-Content .\serviceAccount.json -Raw
```

Fetch only the latest NAVs:

```powershell
python fetch_navs.py
```

Backfill NAV history from July 1, 2025 through today:

```powershell
python backfill_navs.py --start 2025-07-01
```

Backfill including weekends too:

```powershell
python backfill_navs.py --start 2025-07-01 --include-weekends
```

The backfill writes `meezan/portfolio.navHistory`, `public/navHistory.navHistory`, `meezan/fyHistory`, `public/fyHistory`, and the latest available NAVs into `meezan/navs` and `public/navs`.
