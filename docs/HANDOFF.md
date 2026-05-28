# KidPlan - session handoff / status

Last updated: 2026-05-27. Purpose: let a fresh session (or Tyler) pick up without re-deriving context. For the deep plan and decisions, the build plan lives at `~/.claude/plans/create-an-app-to-eventual-honey.md`; tag/column schemas in `docs/data-model.md`; one-time setup in `docs/setup-checklist.md`.

## What this is

Phone-first web app for Tyler + wife Soleil to plan their two kids' summer days. Hybrid source of truth: the app owns plan-data (day-type tags, activities, Plan B, library, photos); Google Calendar owns the time-blocked events; the paper wall calendar is photo-back-synced (Wave 4, not built yet). Throwaway-grade summer 2026 MVP.

## Architecture

- Static single-file frontend `web/index.html` (vanilla, no build) -> talks to a GAS JSON API via header-less POST (text/plain, avoids CORS preflight).
- GAS standalone web app (`gas/`) deployed under `soleilandtyler@gmail.com`, `executeAs USER_DEPLOYING` + `access ANYONE_ANONYMOUS`.
- Google Sheets = data store (6 tabs). Google Calendar = event writes. Google Drive = photo archive (Wave 4). Cloud Vision = OCR (Wave 4).
- Auth: shared secret `API_TOKEN` (NOT Google identity - `Session.getActiveUser()` is empty on a personal-Gmail web app). Token entered once per device, stored in localStorage, sent in every request body. Never in the repo/bundle.

## Key coordinates

- GitHub: `github.com/hiretyler/kidplan` (private). Local: `/Users/tylergeddes/projects/KidPlan`.
- GAS Script ID: `1FYSj3sQ-ddQgacjWmPnicZ297ufV-Q3aNi4DFSzstkLgZe6LjDnREoFb`
- Editor: `https://script.google.com/d/1FYSj3sQ-ddQgacjWmPnicZ297ufV-Q3aNi4DFSzstkLgZe6LjDnREoFb/edit`
- Deployment ID (stable - always redeploy with `-i` this): `AKfycbxJ7oc6WazWnkr0YLrE9S-2c4w04Xz6K4bRgx276EkJPYJN3Z48lnO56QeF9Hlm02ye`
- `/exec` URL: `https://script.google.com/macros/s/<deploymentId>/exec` (currently @5)
- Family calendar ID (script prop `FAMILY_CALENDAR_ID`): `3716c55ac1e5c3159e66479cf85951e662bacb12f4ed00da0cf2d0db86a2cff3@group.calendar.google.com`
- Script Properties set: `API_TOKEN`, `SHEET_ID`, `FAMILY_CALENDAR_ID`. Optional/unset: `READ_ONLY_CALENDAR_IDS`, `FRONTEND_URL`. Secrets live ONLY in Script Properties.
- GCP project: still "Default" - must switch to a standard Cloud project before Wave 4 (Vision).

## Deploy / dev workflow

Multi-account clasp via per-account credential files. Wrapper in `~/.zshrc`: `clasp-soleil` = this account.
```
cd /Users/tylergeddes/projects/KidPlan/gas
clasp-soleil push
clasp-soleil deploy -i AKfycbxJ7oc6WazWnkr0YLrE9S-2c4w04Xz6K4bRgx276EkJPYJN3Z48lnO56QeF9Hlm02ye
```
Editor-run setup/migration functions (no trailing underscore so they show in the Run dropdown), open the file in the editor and pick from the function dropbox: `setupSeedSheet`, `migrateMergeChillIntoIndoor`, `ensureLibraryFallbackPerTag`. clasp can run push/deploy from a non-interactive shell with `clasp_config_auth=~/.clasp-accounts/soleilandtyler.json clasp ...`; editor functions cannot be triggered from the CLI.

Frontend deploy: upload the 4 files in `web/` (`index.html`, `manifest.webmanifest`, `icon-512.png`, `icon-192.png`) to `tgeddes.com/kidplan/` over HTTPS. `API_URL` is baked into `index.html`. NOT yet hosted.

## Wave status

- Wave 1 (scaffold), Wave 2 (backend wiring), Wave 3 (frontend live integration): DONE.
- Wave 3.1 (harden plan-item save, merge chill->indoor, fallback per tag): DONE + migrations run on live sheet.
- Wave 3.2 (palette C, two-section Library, unified tags): DONE.
- Wave 3.3 (library-first activity picker: instant-add, inline lane/time, "+ New activity" saves to library, Plan B from picker): DONE.
- PWA icons (coral "K") generated; manifest aligned to palette C.
- Wave 4 (photo + Cloud Vision OCR reconcile loop): NOT STARTED. Prereqs: switch GCP off "Default", enable Vision API, service-account JSON into `VISION_SERVICE_ACCOUNT_JSON` script prop. `gas/drive.gs` and `gas/vision.gs` are still stubs.
- Wave 5 (end-to-end verify on both phones + `simplify` pass): NOT STARTED.

## Just fixed (verify next session) - commit a877b29, deploy @5

Two bugs in the add-activity flow:
1. All-day calendar events landed one day early. Root cause: `dateOnly_` in `gas/calendar.gs` built the date at midnight local, which TZ conversion rolled back a day (classic GAS all-day off-by-one). Fix: anchor at noon. DEPLOYED.
2. Added activities did not appear on the Today tab. Root cause: `viewToday()` in `index.html` showed the empty state whenever there was no `Days` row, hiding activities added before a day type was set. Fix: render the populated view when activities exist, with default day fields. Frontend only - needs a refresh / re-host to take effect.

Verify: open the app on the real current date, "+ Add activity" -> pick a library item -> it should appear under Activities AND create an all-day event on the SAME day in the family calendar.

## Cleanup owed

5 duplicate "[Shared] Rainy-day craft kit" test events were created on the wrong day during debugging, plus their `PlanItems` rows (date = the test day). After the fixes, those rows will now show on Today - delete the duplicates via the x button on each activity, and delete the stray calendar events.

## Gotchas already learned (vault notes exist)

- clasp v3 dropped `--type webapp` -> use `create-script --type standalone`; web-app config lives in `appsscript.json`. (`~/vault/Tools/clasp-create-script-setup-gotchas.md`)
- clasp multi-account via `clasp_config_auth`. (`~/vault/Tools/clasp-multi-account-auth-file.md`)
- GAS const arrows are not hoisted across files; use `function` declarations for load-time cross-file refs. (`~/vault/Tools/gas-const-arrow-not-hoisted-across-files.md`)
- Trailing-underscore GAS functions are private and hidden from the editor Run dropdown.
- `Session.getActiveUser()` is empty on a personal-Gmail web app -> token auth instead. (`~/vault/Tools/apps-script-get-active-user-email-empty.md`)
- GAS all-day events: build the anchor Date at noon to avoid the off-by-one.
