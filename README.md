# Quote Logger Browser Extension

## Overview

Quote Logger is a Chromium extension that records spot quotes from customer portals and posts them to your Quote Log Google Sheet through a pre‑built Google Apps Script.  
Currently the extension supports Boeing’s Blue Yonder portal but the codebase is designed to support additional customers in the future.

## Features

- Scrapes the **Accepted Loads** table in Blue Yonder and extracts load ID, rate, equipment, origin/destination, miles, and more.
- Sends new loads to the Google Apps Script web app and updates status and rates for existing Load IDs.
- Displays a summary of how many loads were added, updated, or had rate changes.
- Stores a default team selection and offers a light/dark theme toggle.
- "Recent Quotes" view shows the latest entries and lets you edit their status, rate, or notes.
- Normalizes equipment descriptions and maps Blue Yonder statuses to Quote Log values.

## Installation

1. On GitHub, click the green **Code** button and choose **Download ZIP**. Extract the archive on your computer.
2. In Chrome or Edge open the extensions page (`chrome://extensions` or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted repository's `extension` folder.

## Usage

1. Log in to Boeing's Blue Yonder portal and open the **Accepted Loads** table.
2. Click the Quote Logger icon and press **Capture Quotes**.
3. A notification and in‑popup status display the number of loads added, status changes, and rate updates.
4. Use **View Recent Quotes** to open a window showing your last 10 submissions where you can adjust status, rate, or notes and save the changes.

## Notes

- Status mapping: "Bid Pending/Submited" → Pending, "Bid Rejected" → Lost, "Load Awarded" → Won, "Load Removed from Auction" → Ended.
- Equipment names are normalized (e.g., "Curtainside - 53 FT" becomes "Conestoga").
- The extension communicates with the existing QuoteLog Apps Script used by other tooling. No additional setup is required.

## Future Plans

Future updates will add support for more customer portals beyond Boeing.