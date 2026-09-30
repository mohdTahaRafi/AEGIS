# AEGIS privacy policy

AEGIS is a browser extension that operates web pages on your behalf. It is built so that the AI model
that plans each step never receives your sensitive data.

## What stays on your device

Everything that reads your screen runs inside the extension, in your browser:

- the page reader, the on-device vision models (face, text, image screening) and the detectors that
  find sensitive values (Aadhaar, PAN, card numbers, phone, email, passwords, faces, ID documents, …);
- the vault that holds real values, in memory only and cleared when a task ends;
- the check that re-scans everything just before it is sent.

The models are part of the extension package. Nothing is downloaded after installation.

## What is sent, and where

For each step of a task, the extension sends one request to **api.groq.com** (Groq, an inference
provider), authenticated with **your own Groq API key**. The request contains:

- your task text, after sensitive values in it have been replaced by typed placeholders such as
  `⟪AADHAAR#2⟫`;
- a description of the page's elements (roles, names, positions) with sensitive values replaced by
  placeholders;
- a screenshot in which sensitive regions are blacked out and unanalysed regions are grey.

It never contains a real sensitive value: values are replaced before the request is built, and the
request is checked again immediately before it leaves. If a check fails, nothing is sent. Real values
are put back into the page only inside your browser, and only for actions you have confirmed.

Groq's own handling of the data it receives is governed by Groq's terms and your account settings
(for example its Zero Data Retention control). Because the key is yours, requests are attributed to
your Groq account.

## Your API key

You enter it in the extension. It is stored in the extension's local storage in your browser, sent only
to `api.groq.com` as a bearer token, never logged, and never sent to us or anywhere else. Remove it any
time in Settings, or by uninstalling the extension.

## What we collect

Nothing. The extension has no server, no analytics, no telemetry, and no account. We do not receive your
tasks, pages, screenshots or key.

## Permissions

`activeTab`, `scripting`, `tabs` (read and act on the page you invoke AEGIS on, and tabs it opens),
`storage` (settings and key), `sidePanel` (the panel), the host permission `https://api.groq.com/*`
(send the redacted step), and optional per-site access that you grant when you run a task.
