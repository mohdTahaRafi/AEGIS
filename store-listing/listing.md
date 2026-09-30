# Chrome Web Store listing — AEGIS

**Name:** AEGIS
**Category:** Productivity
**Language:** English
**Visibility:** Unlisted
**Privacy policy URL:** https://github.com/mohdTahaRafi/AEGIS/blob/main/PRIVACY.md  (needs the repo public and PRIVACY.md pushed)

## Summary (max 132 chars)
A browser agent that does web tasks for you without the AI ever seeing your sensitive data.

## Description
AEGIS lets an AI model operate web pages for you (filling forms, searching, navigating portals) while your sensitive data never leaves your device.

HOW IT WORKS
• AEGIS reads the page on your device: its structure and a screenshot, with on-device vision models (face detection, text reading, image screening) that ship inside the extension. Nothing extra is downloaded.
• Anything sensitive (Aadhaar, PAN, card numbers, phone, email, passwords, faces, ID documents and more) is replaced by a typed placeholder such as ⟪AADHAAR#2⟫ and blacked out in the screenshot.
• Only that redacted view goes to the AI model. It plans the next step; AEGIS checks the plan on your device and performs it. When a real value must be typed, it is put back locally, inside your browser, after your confirmation.
• If any check fails, nothing is sent.

BRING YOUR OWN KEY
AEGIS uses your own Groq API key (free to create at console.groq.com/keys). The key stays in your browser and is sent only to api.groq.com. There is no AEGIS server, account, analytics or telemetry.

GOOD TO KNOW
• Works on http(s) pages. You choose when AEGIS runs, by clicking its toolbar icon.
• On Groq's free tier, steps are spaced about a minute apart; a paid Groq key removes the wait.
• AEGIS stops at CAPTCHAs and hands control back to you.

## Single purpose
Operate web pages on the user's behalf from a task they type, while redacting sensitive data on the device before anything is sent to the AI model.

## Permission justifications
- activeTab: capture a screenshot of the tab the user invoked AEGIS on (granted by the toolbar click).
- scripting: inject the page reader into the task's tab.
- tabs: find the task's tab and follow tabs the task opens.
- storage: keep the user's settings and their API key in this browser.
- sidePanel: show the AEGIS panel.
- Host permission https://api.groq.com/*: send the redacted step to the model with the user's own key.
- Optional host permission (all sites): requested per site when the user runs a task there, to read and act on that page.
- Content script on all pages: reads page structure for the task; contains no network code.

## Data usage disclosures (Privacy tab)
- Collects: "Website content" and "Authentication information" are handled, redacted on device, and sent only to the user's own Groq account. Not sold, not used for unrelated purposes, not used for creditworthiness or lending.
- Remote code: No. All code and models are in the package.

## Files
- Package: apps/extension/.output/aegis-0.1.0-chrome.zip
- Icon 128: apps/extension/public/icons/128.png
- Screenshots (1280x800): store-listing/screenshot-*.png
- Small promo tile (440x280): store-listing/promo-tile-small-440x280.png
