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

## Admin-Assisted Password Reset

This app includes a callable Firebase Cloud Function named `adminResetPassword`. It lets a signed-in Wafrah admin set a temporary password for a user from the Admin tab. The function verifies the caller's `users/{uid}.role` is `admin`, updates the user's Firebase Auth password with the Admin SDK, and marks the user with `forcePasswordChange: true` so they are sent to Settings to choose their own password after signing in.

Deploy the function and rules from this folder:

```powershell
cd D:\ClaudeProject\Wafrah_Public
npm --prefix functions install
firebase deploy --project wafrah2 --only functions,firestore:rules
```

If Firebase asks, enable Cloud Functions for the project. Functions may require the Firebase project to be on the Blaze plan.

Use the reset flow like this:

1. Open Wafrah as an admin.
2. Go to Admin > User Logins.
3. Verify the user by mobile number or another trusted channel.
4. Enter a temporary password twice and click Set Temp Password.
5. Tell the user the temporary password. On sign-in, Wafrah will ask them to change it.

Existing users created before mobile-number signup may show "No mobile saved". Add their mobile number in Firestore under their `users/{uid}` document if you want mobile-based verification for them.