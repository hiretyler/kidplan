# KidPlan - session handoff / status

Last updated: 2026-06-10 (frontend HOSTED at tgeddes.dev/kidplan, both phones logged in; first real two-person use surfaced the upsertRow_ column-wipe bug -> duplicate GCal events + broken deletes; fixed and LIVE @19, but the frontend re-upload + one-time `cleanupCalendarOrphans` editor run are still PENDING - see RIGHT NOW). Purpose: let a fresh session (or Tyler) pick up without re-deriving context. For the deep plan and decisions, the build plan lives at `~/.claude/plans/create-an-app-to-eventual-honey.md`; tag/column schemas in `docs/data-model.md`; one-time setup in `docs/setup-checklist.md`.

## What this is

Phone-first web app for Tyler + wife Soleil to plan their two kids' summer days. Hybrid source of truth: the app owns plan-data (day-type tags, activities, Plan B, library, photos); Google Calendar owns the time-blocked events; the paper wall calendar is photo-back-synced (Wave 4, not built yet). Throwaway-grade summer 2026 MVP.

## Architecture

- Static single-file frontend `web/index.html` (vanilla, no build) -> talks to a GAS JSON API via header-less POST (text/plain, avoids CORS preflight).
- GAS standalone web app (`gas/`) deployed under `soleilandtyler@gmail.com`, `executeAs USER_DEPLOYING` + `access ANYONE_ANONYMOUS`.
- Google Sheets = data store (5 tabs after Wave 3.5: PlanItems, Library, Tags, Photos, Settings - Days removed). Google Calendar = event writes. Google Drive = photo archive (Wave 4). Cloud Vision = OCR (Wave 4).
- Auth: shared secret `API_TOKEN` (NOT Google identity - `Session.getActiveUser()` is empty on a personal-Gmail web app). Token entered once per device, stored in localStorage, sent in every request body. Never in the repo/bundle.

## Key coordinates

- GitHub: `github.com/hiretyler/kidplan` (private). Local: `/Users/tylergeddes/projects/KidPlan`.
- GAS Script ID: `1FYSj3sQ-ddQgacjWmPnicZ297ufV-Q3aNi4DFSzstkLgZe6LjDnREoFb`
- Editor: `https://script.google.com/d/1FYSj3sQ-ddQgacjWmPnicZ297ufV-Q3aNi4DFSzstkLgZe6LjDnREoFb/edit`
- Deployment ID (stable - always redeploy with `-i` this): `AKfycbxJ7oc6WazWnkr0YLrE9S-2c4w04Xz6K4bRgx276EkJPYJN3Z48lnO56QeF9Hlm02ye`
- `/exec` URL: `https://script.google.com/macros/s/<deploymentId>/exec` (currently @18 - Wave 4a + 4b live).
- Family calendar ID (script prop `FAMILY_CALENDAR_ID`): `3716c55ac1e5c3159e66479cf85951e662bacb12f4ed00da0cf2d0db86a2cff3@group.calendar.google.com`
- Script Properties set: `API_TOKEN`, `SHEET_ID`, `FAMILY_CALENDAR_ID`, `PHOTO_DRIVE_FOLDER_ID` (= `1F1Nfq8_K_zyf0dU_ZfYg_iehcBQLAfXi`), `GEMINI_API_KEY`. Optional/unset: `READ_ONLY_CALENDAR_IDS`, `FRONTEND_URL`, `GEMINI_MODEL` (defaults to `gemini-2.5-flash`). Secrets live ONLY in Script Properties.
- GCP project: standard Cloud project `kidplan` (project number `444981393891`), **Vision API + Drive API enabled, billing attached** (Vision needs billing; first 1000 OCR/mo free). OAuth consent in Testing mode with soleilandtyler@gmail.com as the only Test user. Apps Script linked to this GCP project; deployer consented to the `cloud-vision` + full `drive` scopes (DriveApp.createFile into a pre-made folder needs full `drive`).
- Gemini key: created in a **separate, no-billing project** (a key in the billing-enabled `kidplan` project gets treated as paid/prepay and 429s "prepayment credits depleted"). Free tier ~1500 req/day.

## Deploy / dev workflow

Multi-account clasp via per-account credential files. Wrapper in `~/.zshrc`: `clasp-soleil` = this account.
```
cd /Users/tylergeddes/projects/KidPlan/gas
clasp-soleil push
clasp-soleil deploy -i AKfycbxJ7oc6WazWnkr0YLrE9S-2c4w04Xz6K4bRgx276EkJPYJN3Z48lnO56QeF9Hlm02ye
```
Editor-run setup/migration functions (no trailing underscore so they show in the Run dropdown), open the file in the editor and pick from the function dropbox: `setupSeedSheet`, `migrateDateColumnsToText`, `migrateToBackupsModelV2`. (The old `migrateMergeChillIntoIndoor` and `ensureLibraryFallbackPerTag` were deleted in Wave 3.5.) clasp can run push/deploy from a non-interactive shell with `clasp_config_auth=~/.clasp-accounts/soleilandtyler.json clasp ...`; editor functions cannot be triggered from the CLI.

Frontend deploy: upload the 4 files in `web/` (`index.html`, `manifest.webmanifest`, `icon-512.png`, `icon-192.png`) to `tgeddes.dev/kidplan/` over HTTPS. `API_URL` is baked into `index.html`. NOT yet hosted.

## Wave status

- Wave 1 (scaffold), Wave 2 (backend wiring), Wave 3 (frontend live integration): DONE.
- Wave 3.1 (harden plan-item save, merge chill->indoor, fallback per tag): DONE + migrations run on live sheet.
- Wave 3.2 (palette C, two-section Library, unified tags): DONE.
- Wave 3.3 (library-first activity picker: instant-add, inline lane/time, "+ New activity" saves to library, Plan B from picker): DONE.
- Wave 3.5 (re-alignment - per-activity backups, calendar conflict awareness, schema collapse): LIVE; migration ran on live sheet.
- PWA icons (coral "K") generated; manifest aligned to palette C.
- Wave 4a (capture + OCR plumbing, raw text view): DONE + LIVE. Camera -> Drive -> Vision OCR verified end to end.
- Wave 4b (parse OCR into PlanItem candidates + review/accept UI): DONE + LIVE (@18), but accuracy is **PRIMITIVE and paused** - see the "PRIMITIVE" backlog section below. Pipeline = Vision word boxes -> grid reconstruction (`gas/parse.gs`) -> Gemini Flash cleanup (`gas/gemini.gs`, regex fallback) -> review pane -> `reconcile_photo` upserts accepted events as `source='ocr'`. NOTE: the live "Add events" -> calendar write path has NOT yet been exercised by a real reconcile (do this as part of Wave 5).
- Wave 5 (end-to-end verify on both phones + `simplify` pass): simplify pass DONE; phone verify PENDING (blocked on hosting the frontend).

## RIGHT NOW - pick up here (2026-06-10)

Frontend is HOSTED at `tgeddes.dev/kidplan/`, both phones logged in. First real use by Soleil (2026-06-10) hit the **upsertRow_ column-wipe bug**: `upsertRow_` wrote the full row width so any column missing from a patch was blanked - the client never sends `gcal_event_id`, so every inline edit wiped it, every save took the calendar CREATE path (one orphan GCal event per edit), and deletes could not find their event. Fixed and deployed @19 (commit `5f58b42`): `upsertRow_` now merges over the existing row; `writePlanItemToCalendar_` adopts an event tagged `KidPlan item <id>` before creating; `deletePlanItemFromCalendar_` sweeps id-tagged strays; client mints real PlanItem ids (`genId()`, `_saving` flag replaces `temp_` ids), keeps in-flight rows across refetches, and patches state locally instead of `loadView()` reload storms.

Remaining:

1. **Re-upload `web/index.html` to `tgeddes.dev/kidplan/`** - the deployed @19 backend already stops duplicate events, but the hosted frontend still has the reload storms, stuck "Saving..." rows, and re-add-duplicate path until re-uploaded.
2. **Run `cleanupCalendarOrphans` once** from the GAS editor (Run dropdown, `calendar.gs`). Re-links rows whose `gcal_event_id` was wiped, deletes orphaned/duplicate `KidPlan item`-tagged events across 2026 (the June 11 mess), never touches external events. Logs a kept/relinked/orphans/dupes summary. This also covers the old pre-3.5 test-event cleanup debt.
3. **Wave 5 phone verify.** On both phones: run the core flow (add activity from library -> appears on Today + family Google Calendar; edit time -> SAME event moves; delete -> event disappears; week view; backups). Then do one real **photo import -> Add events** to finally exercise the `reconcile_photo` calendar-write path live.
4. **Push to GitHub.** Local `main` is ahead of `origin/main` by the Wave 4a/4b/5 + bugfix commits - push when ready.

## Wave 3.5 - shipped LIVE on @8 (2026-05-28)

Tyler redirected the product after the date TZ fix landed: drop the day-level model (day types, plan_a_summary, day-level Plan B), make backups per-activity, surface external calendar events for conflict awareness, and require start times on every activity. Three Opus subagents (code / UX / data-model) audited the codebase and the new plan was committed to `~/.claude/plans/create-an-app-to-eventual-honey.md` (v2).

What landed:
- `gas/sheets.gs` — drop `Days` from `SHEET_HEADERS_`; PlanItems gains `description`, `is_backup`, `backup_for_id`; `is_backup` registered in `BOOLEAN_COLUMNS_`; deleted the dead one-shots `migrateMergeChillIntoIndoor` + helpers + `ensureLibraryFallbackPerTag`; new editor function `migrateToBackupsModelV2` (idempotent, gated by Settings key `backups_migrated`). Also added module-level `asBool_` helper.
- `gas/api.gs` — removed `upsert_day` / `list_days` / `delete_day` and their ROUTES; renamed `duplicate_day_to_range` → `duplicate_plan_items_to_range` (preserves backup pairing via id remap); `upsert_plan_item` now requires `start_time`, accepts `is_backup` + `backup_for_id`, validates pairing, drags the paired backup along on primary edits; `delete_plan_item` cascades; new `list_calendar_events({start,end,calendar_ids})` tags each event `source: kidplan|external`; `list_conflicts` is a thin back-compat wrapper; `delete_plan_items_for_date` requires `confirm: true`.
- `gas/calendar.gs` — `writePlanItemToCalendar_` prefixes `[Backup]` and applies `CalendarApp.EventColor.GRAY` when `is_backup = TRUE`; events are always timed (end defaults to start + 60 min when blank); new range-aware `listCalendarEvents_` returns the shape `list_calendar_events` consumes.
- `web/index.html` — deleted day editor (open/render/toggle/save), Plan-B-from-picker functions, the header pencil; rebuilt `viewToday` (hero is date + nav only, single timeline with nested backups + external events with `~` glyph and "from <name>" caption); rebuilt `viewWeek` (date + per-activity colored chips + grey ticks for externals, no day stripe); rebuilt `viewLibrary` (single flat list, no two-section split); new "When?" sheet (required start_time + Shared/Elder/Younger toggle) sits between the picker and the save; new `openBackupPicker` flow nests the paired backup under its primary with an `Add backup` ghost button; bottom nav is 4 tabs (Photos demoted to a camera button in the Today header). Library items pre-fill `end_time` from `typical_duration_min` on add. New `addMinutesToTime` + `suggestNextHour_` JS helpers, plus CSS for `.backup-row`, `.add-backup-btn`, `.external-event`, `.week-chip`, `.week-tick`.
- `docs/data-model.md` — rewritten to match the new 5-tab schema; explicit "Removed tab: Days" footer.

Live status as of 2026-05-28: deployed, migration ran, two follow-on bugs fixed:
1. Time-column auto-coercion: `start_time` / `end_time` were being stored as fractional-day serials (same class as the date TZ bug); fixed by extending the text-storage approach via `TIME_ONLY_COLUMNS_` + `TEXT_STORED_COLUMNS_`. The existing `migrateDateColumnsToText` editor function now covers time columns too and was re-run.
2. Temp-id race on `+ Add backup`: the affordance was clickable on an optimistic temp row before the server response replaced the temp id, producing `backup_for_id does not exist: temp_...`. Fixed by hiding the button behind a passive "Saving..." caption while the row is still a temp.

Tyler verified the full flow works end-to-end (primary → backup → calendar). Wave 3.5 is done.

Cleanup owed (not blocking): old test events from pre-3.5 still in the live calendar and sheet.

## Wave 4a - pushed, awaiting deploy + script prop + first test

Code shipped to disk + Apps Script project on 2026-05-28; not yet deployed; not yet tested.

What landed:
- `gas/appsscript.json` - added `https://www.googleapis.com/auth/cloud-vision` to `oauthScopes`.
- `gas/drive.gs` - replaced stubs with `getPhotoFolderId_()` (script-prop-first with Settings tab fallback), `uploadPhotoToDrive_(base64, mime, filename)` returning the new Drive file id, `readDriveFileAsBase64_(fileId)` for re-feeding to Vision, and `defaultPhotoName_()` for timestamp-stamped filenames.
- `gas/vision.gs` - `runVisionOcrOnDriveFile_(driveFileId)` calls the Cloud Vision REST endpoint directly via `UrlFetchApp` using `ScriptApp.getOAuthToken()` as the bearer (no service-account JSON needed). Requests `DOCUMENT_TEXT_DETECTION`, returns `fullTextAnnotation.text` or `''`. Throws on transport / auth / quota errors with the response body trimmed.
- `gas/api.gs` - new handlers `upload_photo({image_base64, mime_type, name})` (decodes, writes to Drive folder, appends a Photos row, returns it) and `run_photo_ocr({id})` (looks up the Photos row, runs Vision on its `drive_file_id`, persists the result in `ocr_text`, returns updated row). `list_photos` now returns rows sorted by `uploaded_at desc`. `reconcile_photo` still throws "Not implemented until Phase 4b". Routes table updated.
- `web/index.html` - the camera button in the Today header now calls `openPhotoCapture()` which builds a dynamic file input with `capture=environment` (mobile rear camera) → `onPhotoSelected(file)` reads the file as base64 (via `readFileAsBase64` helper) → POST `upload_photo` → POST `run_photo_ocr` → new modal kind `photoResult` shows the raw OCR text in a scrollable `<pre>` block.

Phase 4b (next) will own: a parser that turns `ocr_text` into structured candidate events `{date, title, start_time, end_time?, kid_hint?, location?, raw}`, a review pane in the frontend that surfaces each candidate as accept / edit / reject, and a `reconcile_photo` handler that upserts accepted candidates via `upsert_plan_item` with `source = 'ocr'` and flips `Photos.reconciled = TRUE` when everything is handled.

OAuth state: the cloud-vision scope was added to `appsscript.json` and the deployer (soleilandtyler@gmail.com) consented interactively by running an editor function. The "Ineligible accounts not added" error and the "Access blocked: app has not completed verification" error both came up during setup and were red herrings (the test user was already on the list; the second was propagation/stale-grant). Both gotchas are now in the vault - see [[apps-script-add-oauth-scope-reauth-flow]].

---

## Previous: TZ date round-trip fix - deploy @6

Date-only columns read back one day early (a day set up for May 27 saved, then displayed on May 26, leaving the real today empty). Root cause: `coerceCellForRead_` in `gas/sheets.gs` formatted date cells with the hardcoded script TZ (`TZ_`, Denver), but `getValues()` builds those Date objects using the spreadsheet's OWN timezone - when the two differ, every stored date shifts. The earlier noon-anchor fix only patched the calendar-write path (`dateOnly_`), never the sheet round-trip. Also found+fixed a latent bug: `upsertRow_` matched the Days `date` key as a string against a Date cell, never matched, and silently appended duplicate Day rows.

Fix (DEPLOYED @6 + migration run on live sheet):
1. `sheetTz_()` reads the spreadsheet's real TZ (cached); `coerceCellForRead_` formats date-only cells with it, reversing the `getValues()` conversion exactly.
2. `upsertRow_` + `setupSeedSheet` store/keep date columns as plain text (`@` format) so they never round-trip through a Date again - also fixes the duplicate-Days bug.
3. New editor migration `migrateDateColumnsToText` converted existing Date cells to text, preserving the visible calendar day. RUN on the live sheet.

Verify: open the app on the real current date. A day type / Plan A summary / Plan B set "today" should appear on today (not yesterday). Then "+ Add activity" -> pick a library item -> it appears under Activities AND creates an all-day event on the SAME day in the family calendar.

## Cleanup owed

5 duplicate "[Shared] Rainy-day craft kit" test events were created on the wrong day during debugging, plus their `PlanItems` rows. Delete the duplicates via the x button on each activity, and delete the stray calendar events. Also check the `Days` tab for any duplicate rows with the same date (from the pre-fix key-match bug) and remove the stale ones.

## Paper-calendar photo import: status = PRIMITIVE (paused 2026-06-09)

The Wave 4a/4b photo->events pipeline works end to end (camera -> Drive -> Vision OCR -> grid reconstruction -> Gemini cleanup -> review pane -> calendar) but accuracy is **primitive and plateaued**. Dates and times for clearly-separated, time-stamped entries are mostly right; densely-packed or multi-line handwriting still mis-merges adjacent entries and mis-assigns the odd date (the review pane is the human safety net). Iterating on the geometry heuristics hit diminishing returns - several passes made little net progress or regressed. **Paused here deliberately** to prioritize getting the app usable on phones.

Open question: **is Gemini earning its place?** Its cleanup (typo fixes, word-order, merge/split) has not clearly outperformed the regex assembler enough to justify the dependency. Re-evaluate before investing more; consider dropping it.

When revisiting, investigate (in rough priority):
- **Better use of Vision** - we currently use only word bounding boxes + a hand-rolled grid. Explore the full block/paragraph/`detectedBreak` hierarchy and `blockType` (see vault note refs in the Wave-4 research) before adding more heuristics.
- **Detect the printed day-divider lines** of the calendar grid (image line/contour detection, e.g. OpenCV-style, or a Document AI table model) so cells come from the actual ruled boxes instead of inferred day-number anchors. This is the most promising fix for the cross-cell event merging.
- **On-paper tactics** - cheap accuracy wins from how we write on the calendar: circle/box each event, consistent left-aligned start, one event per line. Worth testing whether a simple "circle it" convention beats any amount of parsing cleverness.
- **Erased-pencil detection.** Faintly-erased handwriting still gets OCR'd and imported (e.g. "fundraise" on Jun 13 was erased on paper but read as a live event). Detect low-contrast/faint strokes (Vision word confidence or stroke darkness) and drop/flag them.

## Gotchas already learned (vault notes exist)

- clasp v3 dropped `--type webapp` -> use `create-script --type standalone`; web-app config lives in `appsscript.json`. (`~/vault/Tools/clasp-create-script-setup-gotchas.md`)
- clasp multi-account via `clasp_config_auth`. (`~/vault/Tools/clasp-multi-account-auth-file.md`)
- GAS const arrows are not hoisted across files; use `function` declarations for load-time cross-file refs. (`~/vault/Tools/gas-const-arrow-not-hoisted-across-files.md`)
- Trailing-underscore GAS functions are private and hidden from the editor Run dropdown.
- `Session.getActiveUser()` is empty on a personal-Gmail web app -> token auth instead. (`~/vault/Tools/apps-script-get-active-user-email-empty.md`)
- GAS all-day events: build the anchor Date at noon to avoid the off-by-one.
- GAS date-only AND time-only sheet columns: `getValues()` returns Dates built in the SPREADSHEET's timezone, so formatting them back with the script TZ shifts dates by a day / times by hours when the two differ. Store both as text (`@` format) and read them via the spreadsheet's TZ to stay stable. (`~/vault/Tools/google-sheets-type-coercion.md`)
- Optimistic UI temp-id race: any affordance on an optimistic row that feeds its id back as a server-side foreign key must be hidden until the temp id has been replaced by the saved id. (`~/vault/Patterns/temp-id-race-in-optimistic-ui.md`)
- Per-activity paired backup via self-referential FK + boolean discriminator. (`~/vault/Patterns/paired-backup-self-referential-fk.md`)
- Google Calendar eventColor 8 (Graphite) is the only color that reads as muted; use for backup events. (`~/vault/Tools/google-calendar-graphite-event-color.md`)
- Adding an OAuth scope to a deployed Apps Script: push doesn't trigger reauth - you must run an editor function interactively. "Ineligible accounts not added" usually means the user is already a test user. "Access blocked / verification required" after adding test users is usually propagation delay or a stale partial grant - revoke at myaccount.google.com/permissions to force-clean. (`~/vault/Tools/apps-script-add-oauth-scope-reauth-flow.md`)
