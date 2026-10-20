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

## What's new in version 0.6.2 (v0.6 branch)

- **Asked again only after you write more.** In every mode, your answers are asked again (an
  update, or the final answers) only when you have written more in that conversation since you
  answered. A 3-minute pause, a move to another conversation, a change of topic or the one-week cut
  alone asks nothing; if nothing was added since your last answers, they count as your final ones.
  An update pop-up left on a tab in the background goes away once you answer elsewhere, and a
  reminder notification goes away once its question is answered.

## What's new in version 0.6.1

- **For testing**: the settings page sets the time until the follow-up check-in in seconds
  (1209600 = 14 days, the study's setting), so a tester can bring the check-in, and the questions
  about past conversations, within minutes. Participants keep the default. The time counts from the
  first advice request and applies to conversations first answered after the change. With a short
  time, a question left unanswered that long is deleted at the next browser start or extension
  reload, the check-in can come while the conversation is still going on (answering it then skips
  the final answers at a change of topic), and a conversation from another device still gets its
  check-in a week after its first answers; the one-week cut stays 7 days.

## What's new in version 0.6.0

- **Past conversations and other devices (optional, off unless you agree on the settings page).**
  The settings page has a new section, "Past conversations and other devices" (it opens once after
  the update). With your agreement the extension also reads your conversation list on the five
  sites, in this browser, while a page of the site is open:
  - *Past conversations* (up to 90 days before you joined): when one looks like a request for
    advice, a small invitation on that site's page (at most twice a day) offers to annotate it in a
    separate tab: first "Did you ask for advice here?" (Yes, No or Skip), then questions like those
    of the two-week check-in. **You can earn $2 for each past conversation you annotate** (up to 20).
    No and Skip are always fine and never affect your participation.
  - *Other devices*: conversations you have after joining in the sites' phone or desktop apps (they
    appear in the website's list too) are asked about like those on the web, one at a time per
    site; if you continue such a conversation on the web, it is asked about there, as usual; an
    advice conversation you continue on your phone gets an "Update your answers?" invitation.
  - The invitations show no text of the conversation; the questions open in the extension's own tab.
    Turning an option off stops the reading and deletes what it found and you did not answer.
- **An advice conversation is complete a week after you first asked** (as when the topic changes):
  later messages in that chat count as a new conversation, so the two-week check-in is about the
  conversation you answered questions about.

## What's new in version 0.5.0

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
  sends anything; if you continue an old chat, only your new messages are checked. The one
  exception is the optional reading of past and other-device conversations (next point).
- **Past conversations and other devices (only if you turned them on, after agreeing on the
  settings page):** the extension reads your conversation list and conversations through the
  site's own web interface, in this browser, while a page of the site is open, at most once a
  minute. Past conversations go back up to 90 days before you joined; other-device conversations
  are those after you joined that the web page did not see. Messages sent while tracking was paused,
  on an excluded site, on days the extension was not running, or before you last used "Delete all
  data" are never read (they do not even leave the chat page into the extension). Only the account
  you were signed in with the first time is read, never a work or team workspace (on Grok, which does
  not say which account is signed in, one account in this browser is assumed, and reading stops while
  the conversation list looks like someone else's). The messages are
  checked by the study's AI model like those on the web; a conversation's text is sent only with
  your answers about it (for a past one, the conversation is shown to you as it will be sent).
  The text of a conversation found but not answered stays on your computer at most 30 days. To keep
  a conversation out, pause tracking: turning the extension off does not keep out what you type
  on your phone meanwhile. "Delete all data" also turns both options off.
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
- An advice conversation ends when the topic changes, after a day without activity, or a week
  after your first advice request in it, whichever comes first.
- Settings page (icon → ⋮ → Options): **pause** tracking, **exclude sites**, list **names to
  remove** from conversations before they are sent, change how long a conversation must be quiet
  to count as finished, turn **past and other-device conversations** on or off, **export** or
  **delete all** data on this computer.
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
- **No past or other-device conversations are found**: they are read only while a page of the site
  is open, a little at a time (one request a minute), and only for the account you were signed in
  with when you turned the option on. If a site stops answering (it may ask the extension to wait,
  or refuse), reading that site pauses by itself; the study team sees this in the heartbeat.
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

- `manifest.json` (Manifest V3, version 0.6.2): permissions `storage`, `unlimitedStorage` (no
  install warning), `alarms`, `notifications`, and host permissions for the five chat sites (plus
  `localhost` for the mock test page); no remote code.
- Past and other-device conversations (0.6, opt-in): `content/history.js` answers the worker's
  requests with the site's reader (`lib/history/<site>.js`: the conversation list and one
  conversation, through the site's own read-only API); `lib/history.js` sorts each turn by who sent
  it (web, past, app, off) and drops the text of turns that may not be read before it leaves the
  page; `background.js` walks each conversation with the same judges, hands open episodes between
  the web page and the walk, and asks through one queue per site (`lib/modes.js` `viaQueue`,
  `queueItem`): a text-free invitation on the site's page, the questions in `ui/checkin.html?item=`.
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
  `paused_at`, `listening_sites`, `excluded_sites`, `sites_without_access`, `read_past`,
  `read_apps`; the heartbeat also `history` (per site: ok, not_yet, waiting, signed_out,
  other_account, blocked, unsupported), `waiting_past`, `joined_at`, `joined_estimated`,
  `install_id`). 0.6 adds `source` (web, app, past) to the episode events, `past_annotation`
  (answers + the redacted transcript of a past episode, with a `fingerprint` to pay each once),
  `past_skipped`, `consent` (`feature`, `accepted`, `version`) and the `prompt` kinds `invite` and
  `card`. 0.6.2: a `prompt` can also end `withdrawn` (the pop-up or invitation was taken away because
  the participant answered the same question elsewhere), and `episode_transcript` carries
  `answer_versions` and `final_due`: when a change of topic or the cut closes an answered episode with
  nothing new since the answers, no final answers are asked (`final_due` false) and the last
  `episode_rating` stands as the final one. The server may answer `GET /config` with
  `{history: {"<site>": false}}` to stop reading a site. On removal Chrome
  opens `<server>/uninstalled?participant_id=...&key=...`, which the study server must answer (it
  records an `uninstalled` event).
- The design document is in `docs/`. The study server, the GPU worker, the tests (unit tests, a
  headless-browser end-to-end test, a smoke test) and the Web Store package live in the
  `plugin/` folder of the main research project.
