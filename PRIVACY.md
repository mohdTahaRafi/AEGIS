# AEGIS privacy policy

AEGIS is a browser extension that operates web pages on your behalf. It is built so that the AI model
that plans each step never receives your sensitive data.

## What stays on your device

Everything that reads your screen runs inside the extension, in your browser:

- the page reader, the on-device vision models (face, text, image screening) and the detectors that
  find sensitive values (Aadhaar, PAN, card numbers, phone, email, passwords, faces, ID documents, …);
- the vault that holds real values, in memory only and cleared when a task ends;
- the panel's view of your current task, so closing the panel does not lose it: the task text you
  typed, the run log (what was sent, which is already redacted, and the model's replies). It is kept in
  the browser's session memory, never written to disk, holds no real sensitive values, and is cleared
  when you close that browser window or the browser, or press Dismiss;
- the check that re-scans everything just before it is sent.

The models are part of the extension package. Nothing is downloaded after installation.

## What is sent, and where

For each step of a task, the extension sends one request to the model provider you chose —
**generativelanguage.googleapis.com** (Google Gemini, the default), **api.groq.com** (Groq),
**api.mistral.ai** (Mistral) or **openrouter.ai** (OpenRouter) —
authenticated with **your own API key** for that provider. Every provider offered serves an
vision model. The request contains:

- your task text, after sensitive values in it have been replaced by typed placeholders such as
  `⟪AADHAAR#2⟫`;
- a description of the page's elements (roles, names, positions) with sensitive values replaced by
  placeholders;
- a screenshot in which sensitive regions are blacked out and unanalysed regions are grey.

It never contains a real sensitive value: values are replaced before the request is built, and the
request is checked again immediately before it leaves. If a check fails, nothing is sent. Real values
are put back into the page only inside your browser, and only for actions you have confirmed.

The provider's own handling of the data it receives is governed by its terms and your account
settings. On their **free tiers, Mistral, Google (Gemini) and OpenRouter's free models may use requests to
improve their models**; what they receive is the redacted request described above, never a real sensitive value.
Check each provider's terms for its retention and training rules. Because the key is yours, requests are attributed to your
account with that provider.

## Your API key

You enter it in the extension. It is stored in the extension's local storage in your browser, sent only
to its own provider's API as a bearer token, never logged, and never sent to us or anywhere else. Remove it any
time in Settings, or by uninstalling the extension.

## What we collect

Nothing. The extension has no server, no analytics, no telemetry, and no account. We do not receive your
tasks, pages, screenshots or key.

## Permissions

`activeTab`, `scripting`, `tabs` (read and act on the task's page and the tabs it opens), `storage`
(settings and key; the current task's view in session memory), `sidePanel` (the panel), the host permissions for the four model APIs (send the
redacted step), and site access on all sites. Site access lets a task read and screenshot pages on any
site it moves to without stopping to ask; Chrome does not allow screenshots with optional site access.
AEGIS reads a page only while a task you started is running on it, and nothing leaves your device
unredacted. You can restrict site access in Chrome's extension settings; AEGIS then asks you to click
its icon on each new site.
