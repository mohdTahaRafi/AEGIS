# AEGIS — Project Overview

**A privacy-preserving AI browser agent.** Smart India Hackathon 2026, Problem Statement 26171.

---

## 1. The problem

AI browser agents work by sending a screenshot of the page to a remote AI model on every step.
If the page shows an Aadhaar number, a password, a bank balance or a face, the AI provider sees it,
and so does every server in between.

## 2. The solution

AEGIS is a browser extension that lets a remote AI complete web tasks for the user
(filling forms, logging in, navigating portals) **without the AI ever seeing the user's sensitive data.**

- All sensitive data is found and hidden **on the user's own device** before anything is sent.
- The AI gets a **label** in place of each value, e.g. `⟪AADHAAR#1⟫` or `⟪PASSWORD#1⟫`. It knows
  *what kind* of data sits *where*, but never the value itself.
- When the AI says "type `⟪AADHAAR#1⟫` into this field", the extension fills in the real value
  **locally**, after the user confirms.
- The server is treated as **untrusted**. Even if it is hacked or logging everything, the user's data
  never reaches it.

---

## 3. Typical flow of one step

```
 User gives a task ──► 1. Read the page ──► 2. Detect sensitive data ──► 3. Hide it
                                                                             │
 7. Act on the page ◄── 6. Check the plan ◄── 5. AI plans the next step ◄── 4. Final safety check
        │
        └── repeat until the task is done, or stop and hand control back to the user
```

1. **Read the page.** The extension reads the page structure: fields, buttons, labels and positions.
   It never reads what is typed inside password, OTP, CVV or card-number fields; it only notes that they exist.
2. **Detect sensitive data.** Three sources run on the device: the page structure, text patterns,
   and on-device AI vision on images.
3. **Hide it.** Every sensitive value is swapped for a typed label. The screenshot is rebuilt so that
   only regions confirmed safe are shown; everything else stays grey.
4. **Final safety check.** A separate checker re-scans the finished message for any real value that
   slipped through. If it finds one, the send is **blocked**.
5. **AI plans the next step.** Only the cleaned message goes to the remote AI model, which replies with
   a small plan such as click, type, scroll, select, or "ask the user".
6. **Check the plan.** The extension checks each action against the live page: does the element still
   exist, is it visible, is it on the same website? Risky actions such as submit or pay need the user's approval.
7. **Act.** The action is performed on the page. Labels are turned back into real values only on the
   device, only in a matching field, and only on the same website.

---

## 4. Models used

| Model | Where it runs | What it does |
|---|---|---|
| **Qwen3.8 27B** (vision-language model, served via Groq) | Remote server | Reads the cleaned page and screenshot, then decides the next action |
| **YuNet** face detector | On device | Finds faces in images so they can be hidden |
| **PP-OCRv5** text detector | On device | Finds text inside images, scanned documents and canvases |
| **PP-OCRv5** text recognisers (English + Devanagari) | On device | Reads that text so it can be checked for sensitive data |
| **CLIP ViT-B/32** image classifier | On device | Classifies images: ID card, Aadhaar, PAN, passport, bank card, signature, QR code, photo of a person, or harmless |
| **Privacy Filter** text model (optional, not included by default) | On device | Finds names, addresses and similar details in free text |

The remote model can be swapped for any compatible open model. A record-and-replay mode lets the demo run
without internet or a GPU.

---

## 5. How redaction works, step by step

1. **Structure check.** Field labels and types flag sensitive fields (Aadhaar, PAN, password and so on).
   Password-type fields are never read at all.
2. **Pattern check.** Built-in recognisers scan the visible text for **13 Indian and common data types**:
   Aadhaar, PAN, GSTIN, IFSC, UPI ID, card number, phone, email, passport, vehicle number, PIN code,
   date of birth and secrets/API keys. Checksum validation (for example on Aadhaar and card numbers)
   cuts down false alarms.
3. **Vision check.** Images, canvases and scanned documents are screened on the device for faces,
   ID documents, signatures, QR codes and readable text.
4. **Fusion.** Results from all checks are merged. A privacy policy ranks each data type
   (Critical / High / Medium / Low). When the system is unsure, it treats the data as sensitive.
5. **Labelling.** Each value gets a typed label. The same value always gets the same label within a
   session, so the AI can reason consistently. The real values stay in a memory-only vault that is
   never saved or sent.
6. **Image rebuild.** The screenshot starts fully grey. Only regions proven safe are copied in, and
   hidden regions show their label. The system sends only as much image as it needs:
   text only, a full cleaned screenshot, or just one cropped area.
7. **Re-scan the output.** The cleaned image is checked again for faces, and for readable text around
   the edges of each hidden box. If anything is found, the image is dropped and only text is sent.
8. **Final guard.** The outgoing message is checked for any known or newly found real value. Any hit
   blocks the send.

**Fail-safe by design:** a crash, timeout or missing model always leads to *more* hiding, never less.

---

## 6. Other features

- **User confirmation** before risky actions, and before any real value is typed into a page.
- **Controlled reveal.** The user can choose to reveal one hidden value to the AI for future steps.
  Each reveal is logged with a reason.
- **CAPTCHA hand-off.** When a CAPTCHA appears, the agent stops and hands control to the user.
  It never tries to solve it.
- **Safety limits.** Step, time and retry budgets stop the agent with a clear reason instead of letting it guess.
- **Stop anytime.** The user can cancel the agent at any moment.
- **Transparency panel.** A side panel shows exactly what the server received, next to the live page.
- **Audit log.** A local record of every step, redaction and approval, which can be exported.
- **Indian languages.** Devanagari-script pages (Hindi, Marathi and others) are read by a dedicated recogniser.
- **Chrome and Firefox** support.

---

## 7. Independent evaluation

A separate evaluation system drives the real extension in a real browser across a corpus of test pages.
It uses its own independently written detectors to check every outgoing message for leaks, so the
project does not grade its own work. It also plants hidden "canary" values that no detector knows
about, to catch blind spots.

It measures:
- **Privacy:** did any sensitive value leak?
- **Usefulness:** did the task still succeed with the data hidden?
- **Speed:** how long each step takes.

---

## 8. One-line summary

> **AEGIS lets an AI complete tasks that need your Aadhaar number, password or photo,
> without the AI ever receiving them.**
