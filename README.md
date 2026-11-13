# Chemical Sector Monitor

A self-running news site on Cloudflare's free plan. It needs no Claude account, no Firecrawl and no news API key.

## Publish it (Windows)

1. Install Node.js LTS from https://nodejs.org if you do not have it.
2. Unzip this folder.
3. Double-click `setup.bat` and follow the three steps.
4. Open the `workers.dev` address it shows, and share that address.

Do not use the upload box in the Cloudflare dashboard. It creates a `drop-` address that cannot refresh. The site needs a database and a schedule, which `setup.bat` sets up.

## How it works

- `src/worker.js` collects headlines from Google News RSS, with Bing News RSS as a backup.
- News updates every 4 hours, and it is stored in the `chemical-monitor` D1 database.
- Refresh updates the section being viewed, at most once every 10 minutes per section.
- Add company needs the admin password. Added companies appear for all visitors and get news automatically.
- The page is `src/page.html`, built into the app. Its key figures and Major trends are fixed text.

## Change something later

Edit the files, then run `npx wrangler@4 deploy` in this folder.
