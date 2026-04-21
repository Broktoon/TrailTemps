---
name: Never go live without explicit instruction
description: Never promote a trail to live status in trail-nav.js or index.html without the user explicitly saying to go live
type: feedback
---

Never update trail-nav.js or the hub index.html to promote a trail from "Coming Next" or "Coming Soon" to live status unless the user explicitly says to go live.

**Why:** The user has stated this multiple times. Going live is a deliberate, user-initiated step — not something to do automatically at the end of a build session.

**How to apply:** When finishing a trail build (index.html, app.js, data files), stop there. Do not touch trail-nav.js badge or hub index.html tile. Wait for explicit instruction like "okay, go live" or "promote PCT to live."
