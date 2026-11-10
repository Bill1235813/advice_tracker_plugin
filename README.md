# Advice Tracker (research study extension)

A Chrome extension used in a university research study on how people ask AI chat assistants
(ChatGPT, Claude, Gemini, Grok, Perplexity) for advice about their own lives, and what happens
afterwards. When part of a conversation looks like you asked the AI for advice about your own
situation, the extension asks whether you really asked for advice, and then a few questions about
the advice (about 5 to 10 minutes; when it asks is explained below). From a week later it asks
whether you made a decision and acted on it, and then how things went. Your answers stay on your
computer until you press **Submit**; they are then sent together with that advice conversation (your
messages and the AI's replies, from your message that asked for advice on), after names, e-mail
addresses, phone numbers and similar details were removed on your computer. If you answer that it was
not advice, that part of the conversation is sent with your No, in the same way.

This folder is the extension itself, so it can be loaded straight into Chrome. A Chrome Web Store
version (one-click install) is in preparation; until then, follow the steps below.

**How it works, in detail:** [`docs/advice-tracker-design.pdf`](docs/advice-tracker-design.pdf).

## What's new in version 0.6.12

- Your **Participant ID is your Prolific ID**.
- An advice conversation now lasts until you change the topic, or until a week after you first
  asked (a day without activity no longer ends it).
- **Send feedback on the study**, under the extension icon, sends the study team anything you want
  them to know.
- When you answer **No** (not advice), that part of the conversation is sent with your No, with
  personal details removed, so the study can see what its model got wrong.

Earlier versions, and the details: [CHANGELOG.md](CHANGELOG.md).

## What you need

- Google Chrome on a computer or laptop (version 121 or newer, from January 2024; Edge and Brave also work).
- An internet connection.
- Your **Prolific ID**: it is your Participant ID in the study.

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
5. The **settings page opens by itself.** Type your Participant ID (your Prolific ID) and click
   **Save**.
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
2. Right after the assistant's first answer, a small pop-up asks only "Did you ask for advice
   here?". The questions come after 3 minutes without typing, a new chat, or a change of subject
   (*"Unrelated: what is the capital of Peru?"*), whichever is first. (This is the study's
   *Combined* mode; the research team sets it, and the popup under the extension icon shows it.)
3. A small **Quick check-in** panel appears at the bottom right of the chat page. The panel
   quotes your request and asks **"Did you ask for advice here?"** (only if you did not answer Yes
   in the pop-up).
4. Click **Yes**, answer all the questions (each one is required), and press **Submit**. Your
   answers are sent with the conversation, after personal details were removed on your computer.
   If it was not advice, click **No**: that part of the conversation is sent with your No.
5. Click the extension icon: *Advice conversations found* shows 1. A chat with only a factual
   question ("What is the capital of Peru?") should **not** trigger the panel.

**Where things go when you click "later"**: the panel comes back after an hour if the chat tab is
still open, otherwise a Chrome notification reminds you. At any time, click the extension icon →
**Quick check-ins** to answer everything that is waiting; a number on the icon shows how many
things are waiting.

From a week after an advice conversation, a small pop-up on a chat site's page asks whether you made
a decision about it. Everything about these follow-ups, and about past conversations, is also on the
**Outcomes** page (extension icon → Outcomes); a Chrome notification reminds you of it every two
days while a question waits.

## What it collects, and your controls

- It works only on the five chat sites above and reads nothing else (no browsing history, no
  passwords, no other websites).
- **Only the messages you send while tracking is on are processed** (your participant ID is set,
  tracking is not paused, and the site is not excluded). Opening an old chat from the sidebar never
  sends anything; if you continue an old chat, only your new messages are checked. The one
  exception is the reading of other-device conversations, and of past ones if you turned that on
  (next point).
- **Other devices (always), and past conversations (only if you turned them on with one click on the
  settings page):** the extension reads your conversation list and conversations through the
  site's own web interface, in this browser, while a page of the site is open, at most once a
  minute. Other-device conversations are those after you joined that the web page did not see;
  past conversations go back up to 90 days before you joined. Messages sent while tracking was paused,
  on an excluded site, on days the extension was not running, or before you last used "Delete all
  data" are never read (they do not even leave the chat page into the extension). On each site,
  only the account you were signed in with the first time is read, whether it is a personal one or a
  work, school or team one; while another account or workspace is open there, reading that site
  stops (on Grok, which does not say which account is signed in, one account in this browser is
  assumed, and reading stops while the conversation list looks like someone else's). The messages are
  checked by the study's AI model like those on the web; a conversation's text is sent only with
  your answers about it, or with your No (for a past one, the conversation is shown to you as it
  will be sent).
  The text of a conversation found but not answered stays on your computer at most 30 days. To keep
  a conversation out, pause tracking: turning the extension off does not keep out what you type
  on your phone meanwhile. "Delete all data" also turns past conversations off.
- **To find advice conversations**, each message you send is checked by the study's own AI model,
  which runs on university computers (no commercial AI service sees your messages). For this
  check the extension sends your new message, your earlier messages in the same part of the
  conversation and, to tell whether you are still on the same topic, the assistant's previous
  reply, all with personal details already replaced on your computer. The study server keeps
  only the yes/no result, never the text, and records no IP addresses.
- **Attachments are recorded by name only**: an uploaded picture appears as `[image]` and a file as
  `[file: its name]`; the extension never reads what is inside them.
- On your computer, a conversation's text is kept only while it is being checked; for an advice
  conversation you answer questions about, until you answer its outcome questions. Conversations
  the study's model finds not to be advice are deleted, and their text is never sent.
- Your answers are sent when you press Submit, together with the advice conversation they are
  about (your messages and the AI's replies, from your message that asked for advice on; earlier
  messages of the chat are not sent); the complete conversation is sent once more when it ends (if
  tracking is paused then, once it is on again; never if you exclude the site).
- When you answer **No** (not advice), that part of the conversation is sent with your No in the
  same way (from the message the model took for an advice request on, with personal details
  removed), so the study team can see what the model got wrong; the conversation is then deleted
  from your computer. A past conversation you **Skip** is deleted and its text is not sent.
  Names, e-mail addresses, phone numbers, web and street addresses, long numbers and similar
  details are replaced with placeholders such as `[NAME]` on your computer before anything is sent;
  add the names that matter most to you in the settings.
- Twice a day the extension sends a heartbeat with counts (found / rated / not advice) and whether
  tracking is on: paused or not, and on which of the five sites it can capture. A change of these
  is reported when it happens, and removing the extension is reported too. The study team uses
  this to know on which days the extension was tracking (see the study e-mail for what this means
  for payment).
- An advice conversation ends when the topic changes, or a week after your first advice request in
  it, whichever comes first.
- Settings page (icon → ⋮ → Options): **pause** tracking, **exclude sites**, list **names to
  remove** from conversations before they are sent, turn **past conversations** on or off,
  **export** or **delete all** data on this computer.
- **Feedback** you type under the extension icon (*Send feedback on the study*) is sent to the study
  team with your participant ID, with names on your list, e-mail addresses, phone numbers and similar
  details replaced on your computer first, as for conversations.
- Putting a panel off ("later") or answering "No" never affects your participation.

Full privacy policy: the link in the study e-mail.

## If something does not work

- **Cannot type in the panel's text boxes** (seen on claude.ai): click **open in a tab** in the
  panel's header; the same questions open in a separate tab where typing always works.
- **No panel appears** after an advice conversation: the panel comes when the rating mode says so
  (see *Try it once*; the popup under the extension icon shows the mode), and you need to be
  online. Then click the icon → *Show captured messages on
  this tab*: it lists the messages the extension sees and how many of your messages in this
  conversation it captured. If it says "No messages found on this page", the chat site changed its
  page layout; if it counts 0 captured messages although you sent some, tell the study team which
  site (both are quick fixes). If the popup says "No access to ...", allow the site again under
  `chrome://extensions` → Advice Tracker → Details → Site access.
- **"No participant ID set"** in the popup: open the settings page and save your ID.
- **"Advice Tracker was updated meanwhile"** in a panel: the extension was updated or reloaded while
  the panel was open, so it could not send your answer. Reload the chat page; questions that still
  wait for an answer are listed under the extension icon → **Quick check-ins** and **Outcomes**.
- **Chrome removed the extension** after an update: repeat "Load unpacked" from the same folder.
- **No past or other-device conversations are found**: they are read only while a page of the site
  is open, a little at a time (one request a minute), and only for the account you were signed in
  with the first time the extension read the site. If a site stops answering (it may ask the
  extension to wait, or refuse), reading that site pauses by itself; the study team sees this in the
  heartbeat.
- **Anything else**: tell the study team with *Send feedback on the study* under the extension icon,
  or e-mail them, with what you did and what you saw; the service-worker log (`chrome://extensions`
  → Advice Tracker → *Inspect views: service worker*) helps if you are comfortable copying it.

## Updating and uninstalling

- **Update**: download the ZIP again, replace the contents of your folder, then on
  `chrome://extensions` click the circular reload arrow on the Advice Tracker card and reload
  your chat tabs. (The Web Store version will update itself.)
- **Uninstall / withdraw**: `chrome://extensions` → **Remove** on the card. To also wipe the local
  data first: Options → *Delete all data on this computer*. Tell the study team if you want your
  submitted data deleted as well.

## For reviewers and developers

- `manifest.json` (Manifest V3, version 0.6.12): permissions `storage`, `unlimitedStorage` (no
  install warning), `alarms`, `notifications`, and host permissions for the five chat sites (plus
  `localhost` for the mock test page); no remote code.
- Past and other-device conversations (0.6; past ones opt-in, other devices always read since
  0.6.11): `content/history.js` answers the worker's
  requests with the site's reader (`lib/history/<site>.js`: the conversation list and one
  conversation, through the site's own read-only API); `lib/history.js` sorts each turn by who sent
  it (web, past, app, off) and drops the text of turns that may not be read before it leaves the
  page; `background.js` walks each conversation with the same judges, hands open episodes between
  the web page and the walk, and asks through one queue per site (`lib/modes.js` `viaQueue`,
  `queueItem`): a text-free invitation on the site's page, the questions in `ui/checkin.html?item=` (a
  past one in `ui/outcomes.html?item=`, 0.6.9).
- `content/capture.js` reads the conversation from the page (per site, `lib/sites.js` names the
  message elements, the parts that hold their text, and the noise inside them: thinking blocks,
  screen-reader labels, buttons) and notes which user messages were sent there; `background.js`
  judges each new message through the study server, one at a time,
  following the state machine in `lib/episodes.js`, and shows `content/rating_panel.js` (or its small
  update and confirm pop-ups) when the rating mode in `lib/modes.js` says so; `lib/redact.js` removes
  personal details from everything sent; `ui/checkin.html` holds pending questions (the quick
  check-ins) and `ui/outcomes.html` the follow-ups and past conversations (one script for both,
  `ui/checkin.js`); `lib/modes.js` `followupStage` and `followupAnswer` are the follow-up's rules
  (0.6.9); `lib/questions.js` has every question (all required); `config.js` holds the server URL
  and study key, and the servers used before (an update moves an install that still has one of
  them to the current server). The settings page hides the research team's settings (the server
  and key, the follow-up time, the quiet time) since 0.6.12: `options/options.html?advanced`
  shows them, for a test.
- Uploads (`POST /events`; the episode events carry `source`: web, app or past; an answer to a
  question that does not apply is `null`, e.g. `outcome` when `too_early` is ticked, `feel_better`
  unless `followed` is `fully` or `partly`):
  - `episode_rating`: answers + the redacted transcript from the opening turn through the answered one.
  - `episode_transcript`: the complete redacted transcript from the opening turn, when an answered
    episode ends (or when tracking is on again, if it ended while tracking was off), with
    `answer_versions` and `final_due` (false when a change of topic or the cut closes an answered
    episode with nothing new since the answers: the last `episode_rating` stands as the final one).
  - `not_advice`: the participant's No (`had_answers`: answers sent before belong to a removed
    episode), with the redacted `transcript` from the opening turn through the episode's last turn,
    as `episode_rating` sends it, and the `redacted` counts (`null` where the text stays, as with
    answers); a past one also its `fingerprint` and `opened_at`.
  - `checkin`: the outcome answers, with `followup` (`ask_from`, `due_at`, `shown`, and the answers
    with their times: `decided`, `decidedAt`, `acted`, `actedAt`, `actWhen`, `plannedAt`); for an
    episode from 0.4 also the conversation as reviewed there (`transcript`, `transcript_edited`).
  - `followup`: each answer to the follow-up's questions (`step` decided, acted or when, `answer`,
    `where` popup or page, the `stage` after it, `days_since_request`, `next_at`, `planned_at`,
    `shown`, `study_end`; no text).
  - `past_annotation` (answers + the redacted transcript of a past conversation, with a
    `fingerprint` to pay each once), `past_skipped`, and `consent` (`feature`, `accepted`, `version`).
  - `prompt`: a question shown (kinds include `invite` and `card`); it can end `withdrawn` (the pop-up
    or invitation was taken away because the participant answered the same question elsewhere).
  - `heartbeat` (twice a day) and `status` (on a change): `tracking`, `paused`, `paused_at`,
    `listening_sites`, `excluded_sites`, `sites_without_access`, `read_past`, `read_apps`; the
    heartbeat also the extension's `version`, `history` (per site: ok, not_yet, waiting, signed_out,
    other_account, blocked, unsupported), `waiting_past`, `joined_at`, `joined_estimated`,
    `install_id`, `followup_stages` and counts (among them `feedback`, `upload_rejected`,
    `upload_rejected_<type>`).
  - `feedback`: what the participant typed under the extension icon (`text`, redacted on the
    computer), the `redacted` counts and the extension's `version`.
- The extension also asks `GET /past?participant_id=` for the fingerprints of the past conversations
  the participant ID annotated, on any install, and `GET /config`, whose `{history: {"<site>": false}}`
  stops reading a site. On removal Chrome opens `<server>/uninstalled?participant_id=...&key=...`,
  which the study server must answer (it records an `uninstalled` event). Each version's changes to
  these: [CHANGELOG.md](CHANGELOG.md).
- The design document is in `docs/`. The study server, the GPU worker, the tests (unit tests, a
  headless-browser end-to-end test, a smoke test) and the Web Store package live in the
  `plugin/` folder of the main research project.
