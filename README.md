# KidPlan

KidPlan is a small phone-first web app Tyler and Soleil use to plan their two kids' summer days. It runs a hybrid source-of-truth model: the app owns the plan-data (day-type tags, Plan A, Plan B, notes, library of fallbacks, calendar photos) while a shared family Google Calendar owns the time-blocked events. The paper wall calendar at home stays the household-visible artifact and is photo-back-synced into the app via Cloud Vision OCR so handwriting on the wall flows back into structured rows.

## Stack

Vanilla single-file HTML and JS frontend deployed to Cloudflare Pages from the `web/` directory. The backend is a Google Apps Script standalone web app running under the shared `soleilandtyler@gmail.com` account, with Google Sheets as the data store, Google Drive for paper-calendar photo archive, Google Calendar for read/write of time-blocked events, and Google Cloud Vision for OCR on uploaded photos. No build step, no framework, no server beyond GAS.

## Status

Throwaway-grade summer 2026 MVP. Optimized to ship in time to actually use this summer. If it earns its keep, v2 in the fall.

## Quick start

See `docs/setup-checklist.md` for the step-by-step Google Cloud, Sheets, Drive, Calendar, clasp, and Cloudflare Pages setup that Tyler runs once.

## Roadmap

See `ROADMAP.md` for the change log, current work, upcoming waves, and backlog.
