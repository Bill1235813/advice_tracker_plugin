# Advice Tracker (research study extension)

A Chrome extension used in a university research study on how people ask AI chat
assistants (ChatGPT, Claude, Gemini, Grok, Perplexity) for advice about their own lives,
and what happens afterwards. When one of your conversations looks like a request for advice,
it asks you six quick rating questions right away and a few follow-up questions two weeks
later. Everything stays on your computer until you press **Submit**, and you choose for each
conversation whether to share the conversation text, only your ratings, or nothing.

This folder is the extension itself, so it can be loaded straight into Chrome. A Chrome
Web Store version (one-click install) is in review; until then, follow the steps below.

## What you need

- Google Chrome on a computer or laptop (version 116 or newer; Edge and Brave also work).
- An internet connection.
- Your **Participant ID** from the study e-mail.

## Install (about two minutes)

1. **Get the code.** On this page click the green **Code** button → **Download ZIP**, then
   unzip it. You get a folder named `advice_tracker_plugin-main` containing `manifest.json`.
   Keep this folder somewhere permanent (Documents, not Downloads): Chrome loads the
   extension from it every time it starts.
   *(Alternatively: `git clone https://github.com/Bill1235813/advice_tracker_plugin.git`.)*
2. **Open the extensions page.** Paste `chrome://extensions` into the address bar and press
   Enter (or Menu ⋮ → Extensions → Manage Extensions).
3. **Turn on Developer mode** with the switch in the top-right corner.
4. Click **Load unpacked** (top left) and select the unzipped folder, the one that contains
   `manifest.json`. The card **Advice Tracker (research study)** appears.
5. The **settings page opens by itself.** Type your Participant ID, choose **what to share**
   after each advice conversation (ratings and the redacted conversation / ratings only / ask
   me every time; you can still change it for any single conversation), and click **Save**.
   The server address and study key are already filled in under "Advanced"; leave them.
   *(If the page did not open: click the puzzle-piece icon → Advice Tracker → ⋮ → Options.)*
6. **Pin the icon**: puzzle-piece icon (top right of Chrome) → pin next to Advice Tracker.
7. **Reload any chat tabs** that were already open (the extension only attaches to pages
   opened after it was installed).

Ignore the "Developer mode extensions" reminder Chrome may show at startup; it is normal
for an extension loaded this way.

## Try it once

1. Go to https://chatgpt.com (or claude.ai, gemini.google.com, grok.com, perplexity.ai),
   start a **new** chat, and ask for advice about a decision as you normally would, for
   example: *"I have two job offers, one pays more but the other is closer to family.
   Which should I take?"*. Let the assistant answer, ask a follow-up if you like.
2. Switch to another tab or window. Within about ten seconds a small **Quick check-in**
   panel appears in the bottom-right corner of the chat page.
3. Answer the six rating questions, pick what to share, and press **Submit**. You can
   expand "Review or edit the conversation" to see exactly what would be sent (e-mails,
   phone numbers, addresses and listed names are already replaced).
4. Click the extension icon: *Advice conversations captured* should show 1.
5. A factual question ("What is the capital of Peru?") should **not** trigger the panel;
   the *discarded* counter goes up by one instead, and the text is deleted.

The two-week follow-up normally arrives as a Chrome notification. To see those questions
now, click the icon → **Open check-ins**.

## What it collects, and your controls

- Only on the five chat sites above; it reads nothing else (no browsing history, no
  passwords, no other websites).
- **Past conversations are not collected.** Opening an old chat from the sidebar shows its
  messages to the extension, but nothing is classified or sent unless the conversation grows
  while the extension is watching. If you continue an old chat, the whole thread counts as
  the conversation.
- **It reads both your messages and the assistant's replies** on the page, but only your
  own messages are sent to decide whether the conversation is an advice request. The
  assistant's replies leave your computer only inside a conversation you chose to share.
- To decide whether a conversation is an advice request, **your own messages** are sent to
  the study server. The assistant's replies leave your computer only if you choose to share
  the conversation. Conversations that are not advice requests are deleted immediately.
- Ratings and follow-up answers are sent when you press Submit. Twice a day the extension
  sends a heartbeat with counts only (captured / rated / discarded).
- Settings page (icon → ⋮ → Options): **Pause** tracking, **exclude sites**, list **names to
  remove** from shared conversations, **export** or **delete all** data on this computer.
- Skipping a panel ("later", "✕", or "Not an advice request") never affects your participation.

Full privacy policy: `store/privacy_policy.html` in the main project, or the link in the
study e-mail.

## If something does not work

- **Cannot type in the panel's text boxes** (seen on claude.ai): click **open in a tab** in
  the panel's header; the same questions open in a separate tab where typing always works.
- **No panel appears** after an advice conversation: click the icon → *Show captured messages
  on this tab*. If the list is empty, the chat site changed its page layout; tell the study
  team which site (the fix is a one-line update). If messages are listed, wait a minute (the
  server classifies after the conversation has been quiet) and make sure you are online.
- **"No participant ID set"** in the popup: open the settings page and save your ID.
- **Chrome removed the extension** after an update: repeat "Load unpacked" from the same folder.
- **Anything else**: e-mail the study team with what you did and what you saw; the
  service-worker log (`chrome://extensions` → Advice Tracker → *Inspect views: service
  worker*) helps if you are comfortable copying it.

## Updating and uninstalling

- **Update**: download the ZIP again, replace the contents of your folder, then on
  `chrome://extensions` click the circular reload arrow on the Advice Tracker card and
  reload your chat tabs. (The Web Store version will update itself.)
- **Uninstall / withdraw**: `chrome://extensions` → **Remove** on the card. To also wipe the
  local data first: Options → *Delete all data on this computer*. Tell the study team if you
  want your submitted data deleted as well.

## For reviewers and developers

- `manifest.json` (Manifest V3): permissions `storage`, `alarms`, `notifications`, and host
  permissions for the five chat sites (plus `localhost` for the mock test page); no remote code.
- `content/capture.js` reads the conversation from the page; `background.js` stores it
  locally, sends the user turns to the study server after a quiet period, shows
  `content/rating_panel.js`, and schedules the follow-up in `ui/checkin.html`;
  `lib/redact.js` does the redaction; `config.js` holds the server URL and study key.
- The study server, the cluster judge worker, tests, the Web Store package and the mock chat
  page live in the `plugin/` folder of the main research project.
