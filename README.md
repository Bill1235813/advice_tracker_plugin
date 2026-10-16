# Advice Tracker (research study extension)

A Chrome extension used in a university research study on how people ask AI chat assistants
(ChatGPT, Claude, Gemini, Grok, Perplexity) for advice about their own lives, and what happens
afterwards. When part of a conversation looks like you asked the AI for advice about your own
situation, the extension asks whether you really asked for advice, and then a few questions about
the advice (about 5 to 10 minutes; when it asks is explained below). Two weeks later it asks how
things went. Your answers stay on your computer until you press **Submit**; they are then sent
together with that advice conversation (your messages and the AI's replies, from your message that
asked for advice on), after names, e-mail addresses, phone numbers and similar details were removed
on your computer.

This folder is the extension itself, so it can be loaded straight into Chrome. A Chrome Web Store
version (one-click install) is in preparation; until then, follow the steps below.

**How it works, in detail:** [`docs/advice-tracker-design.pdf`](docs/advice-tracker-design.pdf).

## What's new in version 0.5.0 (dev branch)

- **Reading the chat pages, fixed for all five sites.** ChatGPT's new page layout is read again
  (it captured nothing before). Only the messages themselves are kept: no "thinking" summaries or
  timers ("Worked for 13s"), no hidden screen-reader labels ("You said", "Gemini said"), no
  repeated copies of your message, no website icons recorded as images. Perplexity's questions are
  captured again. Edited messages, messages sent again with the same words ("continue", "ok"),
  and long chats that a site shows only in part are followed correctly.
- **The conversation is sent with your answers.** When you submit answers about an advice
  conversation, that conversation (your messages and the AI's replies, from your message that asked
  for advice on) is sent with them, with personal details removed automatically on your computer
  first; once more, complete, when the conversation ends. The two-week check-in no longer shows it
  for review (except for conversations from version 0.4, which were promised that review; the text
  of conversations that version 0.3 recorded is never sent, apart from what you chose to share
  then; a conversation still under way at the update counts as a new one). The note under the
  questions says which applies.
  The setting "Hold my answers on this computer" is gone: if you had ticked it, the answers it held
  stay on your computer until you choose, on the settings page (it opens after the update), to send
  or delete them.
- **Nothing is captured** before you enter your participant ID, while tracking is paused, or on a
  site you excluded; messages you send then are never processed, not even later.
- **No skipping.** The questions panel has no ✕ until you have answered once; you can still put it
  off with "later (1 h)", or answer "No" if you did not ask for advice (this removes the
  conversation from the study).
- **The study team sees whether tracking is on**: twice a day, and whenever it changes, the
  extension reports whether tracking is paused and on which of the five sites it can capture (a
  site you excluded in the settings, or whose access you withheld in Chrome, does not count). When
  the extension is removed, Chrome opens a page of the study server that records it.
- "Show captured messages on this tab" (popup) now counts all your captured messages in the
  conversation, also after you went to another chat and came back.

## What's new in version 0.4.2

- **A fourth way of asking, *Combined***, chosen in the settings like the other three:
  - Right after the assistant's first answer to an advice message, a small pop-up asks only
    **"Did you ask for advice here?"** (No removes the conversation, as on the panel). It closes
    by itself after 30 seconds; if you do not answer it, the panel asks it again later.
  - The questions panel comes at whichever happens first: a 3-minute pause, a move to another
    conversation, or a change of topic. After Yes in the pop-up, it starts with the ratings.
  - Later pauses and moves offer an update in the small pop-up (only if the conversation went on
    since); a change of topic asks for your final answers, as in *Switching*.

## What's new in version 0.4.1

- **Every question must be answered** before you can submit (two check-in questions only when
  they apply).
- **No "what to share" choice any more.** Submitting your answers sends the answers only. The
  conversation stays on your computer until the two-week check-in, which shows it with names, e-mail
  addresses, phone numbers and similar details removed; you can delete anything else in it, and it
  is sent when you submit the check-in.
- The check-in page lists free support resources.
- The settings page asks for the study code from the onboarding survey as your Participant ID.

## What's new in version 0.4

- **Three ways of asking**, chosen by the research team in the settings ("When to ask about an
  advice conversation"); a conversation already under way keeps the way it started with:
  - *Frequent*: the questions right after your first advice message; after each follow-up, a
    small pop-up asks whether you want to update your answers (it disappears after 30 seconds).
  - *Switching* (the default): when you move to another conversation, a first set of answers you
    can update later; when you change the topic, your final answers.
  - *Periodical*: at the first 3-minute pause in the conversation; later pauses offer an update.
- **Personal details are removed on your computer before anything is sent**: e-mail addresses,
  phone numbers, web addresses, long numbers (cards, accounts), social security numbers, street
  addresses, @handles, IP addresses and names become placeholders such as `[NAME]` and `[EMAIL]`.
  This now also applies to the messages checked by the study's AI model.
- An advice conversation now lasts until you change the topic or a day goes by without activity;
  closing the tab no longer ends it, so you can come back to it.
- The questions come only once the AI has finished its answer, and an open questions panel follows
  the conversation: if you ask more before answering, the panel shows the new messages, and what
  you already ticked stays. A panel open in two tabs closes in the other one when you answer.

## What was new in version 0.3

- Each message you send is checked as it arrives, so one chat can contain several advice
  conversations (for example a career question, then a coding task, then a family question).
- The questions appear when an advice conversation **ends**: when you change the subject, after
  10 minutes without activity, or when you close the tab.
- The first question is **"Did you ask for advice here?"**. Answering "No" deletes the
  conversation from your computer. After "Yes" come three ratings (helpful, trust, potentially
  harmful) instead of six; you also pick the area of life yourself (9 options, optional).
- Old chats that you only open are never processed, even when you scroll through them.

## What you need

- Google Chrome on a computer or laptop (version 121 or newer, from January 2024; Edge and Brave also work).
- An internet connection.
- Your **Participant ID** from the study e-mail.

## Install (about two minutes)

1. **Get the code.** On this page click the green **Code** button → **Download ZIP**, then
   unzip it. You get a folder named `advice_tracker_plugin-main` (`-dev` for the dev branch)
   containing `manifest.json`.
   Keep this folder somewhere permanent (Documents, not Downloads): Chrome loads the
   extension from it every time it starts.
   *(Alternatively: `git clone https://github.com/Bill1235813/advice_tracker_plugin.git`.)*
2. **Open the extensions page.** Paste `chrome://extensions` into the address bar and press
   Enter (or Menu ⋮ → Extensions → Manage Extensions).
3. **Turn on Developer mode** with the switch in the top-right corner.
4. Click **Load unpacked** (top left) and select the unzipped folder, the one that contains
   `manifest.json`. The card **Advice Tracker (research study)** appears.
5. The **settings page opens by itself.** Type your Participant ID (the study code from the
   onboarding survey, for example `AT-1234-5678-9012`) and click **Save**. The server address and
   study key are already filled in under "Advanced"; leave them.
   *(If the page did not open: click the puzzle-piece icon → Advice Tracker → ⋮ → Options.)*
6. **Pin the icon**: puzzle-piece icon (top right of Chrome) → pin next to Advice Tracker.
7. **Reload any chat tabs** that were already open (the extension only attaches to pages
   opened after it was installed).

Ignore the "Developer mode extensions" reminder Chrome may show at startup; it is normal for an
extension loaded this way.

## Try it once

1. Go to https://chatgpt.com (or claude.ai, gemini.google.com, grok.com, perplexity.ai), start a
   **new** chat, and ask for advice about a decision as you normally would, for example:
   *"I have two job offers, one pays more but the other is closer to family. Which should I
   take?"*. Let the assistant answer; ask a follow-up if you like.
2. With the default *Switching* mode, then either start a new chat (the panel asks for a first
   set of answers) or change the subject in the same chat (*"Unrelated: what is the capital of
   Peru?"*; the panel asks for your final answers). With *Frequent*, the panel appears right after
   the assistant's first answer; with *Periodical*, after 3 minutes without typing. With
   *Combined*, a small pop-up asks only "Did you ask for advice here?" right after the assistant's
   first answer, and the panel comes after 3 minutes without typing, a new chat, or a change of
   subject, whichever is first.
3. A small **Quick check-in** panel appears at the bottom right of the chat page. The panel
   quotes your request and asks **"Did you ask for advice here?"** (in *Combined* mode only if you
   did not answer Yes in the pop-up).
4. Click **Yes**, answer all the questions (each one is required), and press **Submit**. Your
   answers are sent with the conversation, after personal details were removed on your computer.
5. Click the extension icon: *Advice conversations found* shows 1. A chat with only a factual
   question ("What is the capital of Peru?") should **not** trigger the panel.

**Where things go when you click "later"**: the panel comes back after an hour if the chat tab is
still open, otherwise a Chrome notification reminds you. At any time, click the extension icon →
**Open questions & check-ins** to answer everything that is waiting; a number on the icon shows
how many things are waiting.

The two-week follow-up arrives as a Chrome notification. To see those questions now, use the same
button.

## What it collects, and your controls

- It works only on the five chat sites above and reads nothing else (no browsing history, no
  passwords, no other websites).
- **Only the messages you send while tracking is on are processed** (your participant ID is set,
  tracking is not paused, and the site is not excluded). Opening an old chat from the sidebar never
  sends anything; if you continue an old chat, only your new messages are checked.
- **To find advice conversations**, each message you send is checked by the study's own AI model,
  which runs on university computers (no commercial AI service sees your messages). For this
  check the extension sends your new message, your earlier messages in the same part of the
  conversation and, to tell whether you are still on the same topic, the assistant's previous
  reply, all with personal details already replaced on your computer. The study server keeps
  only the yes/no result, never the text, and records no IP addresses.
- **Attachments are recorded by name only**: an uploaded picture appears as `[image]` and a file as
  `[file: its name]`; the extension never reads what is inside them.
- On your computer, a conversation's text is kept only while it is being checked; for an advice
  conversation you answer questions about, until you submit its two-week check-in. Conversations
  that are not advice, or that you mark as not advice, are deleted, and their text is never sent.
- Your answers are sent when you press Submit, together with the advice conversation they are
  about (your messages and the AI's replies, from your message that asked for advice on; earlier
  messages of the chat are not sent); the complete conversation is sent once more when it ends (if
  tracking is paused then, once it is on again; never if you exclude the site).
  Names, e-mail addresses, phone numbers, web and street addresses, long numbers and similar
  details are replaced with placeholders such as `[NAME]` on your computer before anything is sent;
  add the names that matter most to you in the settings.
- Twice a day the extension sends a heartbeat with counts (found / rated / not advice) and whether
  tracking is on: paused or not, and on which of the five sites it can capture. A change of these
  is reported when it happens, and removing the extension is reported too. The study team uses
  this to know on which days the extension was tracking (see the study e-mail for what this means
  for payment).
- Settings page (icon → ⋮ → Options): **pause** tracking, **exclude sites**, list **names to
  remove** from conversations before they are sent, change how long a conversation must be quiet
  to count as finished, **export** or **delete all** data on this computer.
- Putting a panel off ("later") or answering "No" never affects your participation.

Full privacy policy: `store/privacy_policy.html` in the main project, or the link in the study
e-mail.

## If something does not work

- **Cannot type in the panel's text boxes** (seen on claude.ai): click **open in a tab** in the
  panel's header; the same questions open in a separate tab where typing always works.
- **No panel appears** after an advice conversation: the panel comes when the rating mode says so
  (see "What's new in version 0.4" and, for *Combined*, 0.4.2; the popup under the extension icon
  shows the mode), and you need to be online. Then click the icon → *Show captured messages on
  this tab*: it lists the messages the extension sees and how many of your messages in this
  conversation it captured. If it says "No messages found on this page", the chat site changed its
  page layout; if it counts 0 captured messages although you sent some, tell the study team which
  site (both are quick fixes). If the popup says "No access to ...", allow the site again under
  `chrome://extensions` → Advice Tracker → Details → Site access.
- **"No participant ID set"** in the popup: open the settings page and save your ID.
- **"Advice Tracker was updated meanwhile"** in a panel: the extension was updated or reloaded while
  the panel was open, so it could not send your answer. Reload the chat page; questions that still
  wait for an answer are listed under the extension icon → **Open questions & check-ins**.
- **Chrome removed the extension** after an update: repeat "Load unpacked" from the same folder.
- **Anything else**: e-mail the study team with what you did and what you saw; the
  service-worker log (`chrome://extensions` → Advice Tracker → *Inspect views: service worker*)
  helps if you are comfortable copying it.

## Updating and uninstalling

- **Update**: download the ZIP again, replace the contents of your folder, then on
  `chrome://extensions` click the circular reload arrow on the Advice Tracker card and reload
  your chat tabs. (The Web Store version will update itself.)
- **Uninstall / withdraw**: `chrome://extensions` → **Remove** on the card. To also wipe the local
  data first: Options → *Delete all data on this computer*. Tell the study team if you want your
  submitted data deleted as well.

## For reviewers and developers

- `manifest.json` (Manifest V3, version 0.5.0): permissions `storage`, `alarms`, `notifications`,
  and host permissions for the five chat sites (plus `localhost` for the mock test page); no
  remote code.
- `content/capture.js` reads the conversation from the page (per site, `lib/sites.js` names the
  message elements, the parts that hold their text, and the noise inside them: thinking blocks,
  screen-reader labels, buttons) and notes which user messages were sent there; `background.js`
  judges each new message through the study server, one at a time,
  following the state machine in `lib/episodes.js`, and shows `content/rating_panel.js` (or its small
  update and confirm pop-ups) when the rating mode in `lib/modes.js` says so; `lib/redact.js` removes
  personal details from everything sent; `ui/checkin.html` holds pending questions and the two-week
  check-in; `lib/questions.js` has every question (all required); `config.js` holds the server URL
  and study key.
- Uploads (`POST /events`): `episode_rating` (answers + the redacted transcript from the opening
  turn through the answered one), `episode_transcript` (the complete redacted transcript from the
  opening turn, when an answered episode ends, or when tracking is on again if it ended while
  tracking was off), `checkin` (for an episode from 0.4 also the conversation as reviewed
  there, `transcript` and `transcript_edited`, as 0.4 sent it), `prompt`, `not_advice`
  (`had_answers`: answers sent before belong to a removed episode), `heartbeat` and `status` (tracking status: `tracking`, `paused`,
  `paused_at`, `listening_sites`, `excluded_sites`, `sites_without_access`). On removal Chrome
  opens `<server>/uninstalled?participant_id=...&key=...`, which the study server must answer (it
  records an `uninstalled` event).
- The design document is in `docs/`. The study server, the GPU worker, the tests (unit tests, a
  headless-browser end-to-end test, a smoke test) and the Web Store package live in the
  `plugin/` folder of the main research project.
