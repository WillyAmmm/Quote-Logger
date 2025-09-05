Quote Logger Browser Extension

Overview
- Captures accepted loads from Boeing's Blue Yonder portal and syncs to your QuoteLog Google Sheet via the existing Apps Script web app (same URL used by Outlook tooling).
- Adds new loads not yet in the sheet and updates status and rate for existing Load IDs.
- Shows a summary of added, status updates, and rate changes.

Files
- manifest.json: MV3 manifest
- content.js: Scrapes Accepted Loads table in Blue Yonder
- popup.html/css/js: UI to trigger capture and show results
- options.html: Configure Apps Script URL, Team, and Submitted By

Setup
1) In Chrome/Edge, open extensions and enable Developer mode.
2) Load unpacked: select `extensions/quote-logger`.
3) Optional: Open Options to set your default Team. The Apps Script URL is already built-in.

Usage
1) Open Blue Yonder: https://tbc-aztms-pr2.jdadelivers.com/tm/framework/Frame.jsp
2) Navigate to the Accepted Loads table view (acceptedLoadsTable).
3) Click the extension icon and press “Capture Blue Yonder Quotes”.
4) A notification and in-popup status will summarize: Added, Status updates, Rate changes.

Notes
- Equipment types are normalized (e.g., "Curtainside - 53 FT" → "Conestoga", "Dry Van - 53 FT" → "Dry Van").
- Status mapping from Blue Yonder: Bid Pending → Pending; Bid Rejected → Lost; Load Awarded → Won; Load Removed from Auction → Ended.
- If your Apps Script (`Code.gs`) is enhanced to return `statusChanged` and `rateChanged`, the extension will report these precisely. Otherwise, it reports attempted updates.
- Submitted By is no longer collected; the column is left blank on append.
