# Advice Tracker (research study extension)

A Chrome extension used in a university research study on how people ask AI chat assistants
(ChatGPT, Claude, Gemini, Grok, Perplexity) for advice about their own lives, and what happens
afterwards. When part of a conversation looks like you asked the AI for advice about your own
situation, the extension asks whether you really asked for advice, and then a few questions about
the advice (about 1 to 2 minutes; when it asks is explained below). From a week later it asks
whether you made a decision and acted on it, and then how things went (about 4 to 8 minutes). Your answers stay on your
computer until you press **Submit**; they are then sent together with that advice conversation (your
messages and the AI's replies, from your message that asked for advice on), after names, e-mail
addresses, phone numbers and similar details were removed on your computer. If you answer that it was
not advice, that part of the conversation is sent with your No, in the same way.

This folder is the extension itself, so it can be loaded straight into Chrome. A Chrome Web Store
version (one-click install) is in preparation; until then, follow the steps below.

## What you need

- Google Chrome on a computer or laptop (version 121 or newer, from January 2024; Edge and Brave also work).
- An internet connection.
- Your **Prolific ID**: it is your Participant ID in the study.

## Install (about two minutes)

1. **Get the code.** On this page click the green **Code** button → **Download ZIP**, then
   unzip it. You get a folder named `advice_tracker_plugin-main`
   containing `manifest.json`.
   Put this folder somewhere permanent (Documents, not Downloads) **before** you go on.
   **Do not delete, move or rename this folder during the five weeks of the study**: Chrome runs
   the extension from it every time it starts. Without the folder Chrome turns the extension off,
   and the answers and conversations it keeps on your computer for the study are lost with it.
   *(Alternatively: `git clone https://github.com/Bill1235813/advice_tracker_plugin.git`.)*
2. **Open the extensions page.** Paste `chrome://extensions` into the address bar and press
   Enter (or Menu ⋮ → Extensions → Manage Extensions).
3. **Turn on Developer mode** with the switch in the top-right corner.
4. Click **Load unpacked** (top left) and select the unzipped folder, the one that contains
   `manifest.json`. The card **Advice Tracker (research study)** appears.
5. The **settings page opens by itself.** Type your Participant ID (your Prolific ID) and click
   **Save**.
   *(If the page did not open: click the puzzle-piece icon → Advice Tracker → ⋮ → Options.)*
6. **Pin the icon**, so that it stays visible and shows how many questions are waiting:
   click the **puzzle-piece icon** (Extensions) at the top right of Chrome, to the right of the
   address bar; in the list that opens, click the **pin** next to *Advice Tracker (research
   study)*. The Advice Tracker icon now stays next to the puzzle piece.

   ![How to pin Advice Tracker: click the puzzle-piece icon, then the pin next to Advice Tracker; its icon then stays in the toolbar](docs/pin-advice-tracker.png)
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
a decision about it and acted on it, and then how things turned out. If it is too early to tell, say
so, and it asks again two days later. Everything you have not answered yet, and the past
conversations, are on the **Outcomes** page (extension icon → Outcomes); every two days while
anything there is unanswered, a pop-up on your AI chat page and a Chrome notification remind you.
In week 5 of your study the
outcome questions of every advice conversation are due, even if you have not acted yet or it is too
early to tell. With the outcome questions, the Outcomes page shows you the conversation with names,
e-mail addresses, phone numbers and similar details already removed, in a box you can edit: delete
anything else you do not want us to keep before you submit.

## The study's weeks and rules

The study lasts five weeks, counted from when you saved your Participant ID. Click the extension
icon → **Study rules: payments and participation** for your own calendar, what you are paid and
when, and the rules (they are the consent form's). In short:

- **Weeks 1 to 3:** use the AI assistants as usual. The extension looks for advice conversations and
  asks its quick questions.
- **Week 4:** no new advice conversations are collected. One that began before is still followed if
  you continue it, until the end of the week. Follow-up questions go on.
- **Week 5:** the outcome questions of every advice conversation, and the questions about past
  conversations, are due by the end of the week.
- **Pausing:** under 12 hours nothing happens; from 12 to 24 hours you get a reminder and your
  payment is not affected; from 24 hours to 1 week your payment for that week is reduced for the
  time paused; after more than 1 week your participation in the study ends.
- **Your answers are reviewed** by the study team. Updating them when a conversation goes on is
  encouraged, not required. If the extension asks about a conversation that was not advice, answer
  **No**; if it misses one, please use **Report an advice conversation we missed**.
- **A reminder at the end of weeks 1, 2, 3 and 5**, if you were not active in that time or have due
  tasks left (weeks 1 to 3: quick questions not answered; week 5: outcome questions not answered):
  the extension sends it by itself, with the day by which to finish, three days later.
- **Messages from the study team** (for example a request to update), these reminders, and the
  reminder that tracking is still paused show in a small window on your AI chat pages and as a
  notification (if your computer shows Chrome's notifications), and stay under the extension icon →
  **Messages from the study team** until you click OK.

## What it collects, and your controls

- It works only on the five chat sites above and reads nothing else (no browsing history, no
  passwords, no other websites).
- **From the end of week 3 of your study, new conversations are no longer checked**: a message is
  sent to the study's AI model only if it continues an advice conversation that began before, and
  from the end of week 4 none is (past conversations, if you turned them on, are still read).
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
  The text of a conversation found but not answered stays on your computer at most 42 days. To keep
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
- With the outcome questions of an advice conversation, the **Outcomes** page shows you that
  conversation (your messages and the AI's replies) with personal details already removed, in a box
  you can edit. You can delete anything else you do not want us to keep; the conversation is then
  stored on our study server with your answers. The questions about a past conversation show its
  conversation in the same way, and a past conversation you edited is sent only as you left it.
- When you answer **No** (not advice), that part of the conversation is sent with your No in the
  same way (from the message the model took for an advice request on, with personal details
  removed), so the study team can see what the model got wrong; the conversation is then deleted
  from your computer. A past conversation you **Skip** is deleted and its text is not sent.
  Names, e-mail addresses, phone numbers, web and street addresses, long numbers and similar
  details are replaced with labels on your computer before anything is sent; add the names that
  matter most to you in the settings. In what the study stores (your answers, the conversations sent
  with them, your feedback) the labels are numbered: the first name is `[NAME1]`, the next
  `[NAME2]`, and the same name gets the same label again, in any of your conversations (capital
  and small letters make no difference), so the study team can tell that two mentions are
  the same person without knowing who it is. The numbers are your own: `[NAME1]` of two
  participants are two people. To keep them the same, the extension keeps a table on your
  computer, which never leaves it and holds a fingerprint of each detail, not the detail itself;
  "Delete all data" empties it. (The messages checked by the study's AI model have labels without
  numbers, as before.)
- Twice a day the extension sends a heartbeat with counts (found / rated / not advice), whether
  tracking is on (paused or not, and on which of the five sites it can capture), and when you last
  sent a message to one of the five AI assistants (the time only, never the text). A change of what
  is tracked is reported when it happens, and removing the extension is reported too. The study team
  uses this to know that the extension is still installed and when it was tracking (see *Study
  rules* for what a pause means for payment).
- After each heartbeat the extension asks the study server whether the study team has a **message**
  for your participant ID, and tells the server when a message arrived and when you clicked OK on
  it. A message is shown as plain text.
- At the end of each of weeks 1 to 3 and of week 5, and three days later, the extension tells the
  study server what it found: whether you were active (an advice conversation; answers to quick,
  outcome or past-conversation questions, not one-click answers such as whether you decided or
  acted; feedback: yes or no for each), how many advice conversations still have due questions,
  and whether it reminded you. Counts and times only, nothing of a conversation.
- With each set of answers the extension sends how long the questions took you (when they appeared,
  when you finished the first and the last answer, when you pressed Submit). The study team uses it
  when it reviews the quality of the answers.
- An advice conversation ends when the topic changes, or a week after your first advice request in
  it, whichever comes first.
- Settings page (icon → ⋮ → Options): **pause** tracking, **exclude sites**, list **names to
  remove** from conversations before they are sent, turn **past conversations** on or off,
  **export** or **delete all** data on this computer.
- **Feedback** you type under the extension icon (*Send feedback on the study*, or *Report an advice
  conversation we missed*) is sent to the study team with your participant ID, with names on your
  list, e-mail addresses, phone numbers and similar details replaced on your computer first, as for
  conversations.
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
  is open, a little at a time (one request a minute to each site), and only for the account you were signed in
  with the first time the extension read the site. If a site stops answering (it may ask the
  extension to wait, or refuse), reading that site pauses by itself; the study team sees this in the
  heartbeat.
- **Anything else**: tell the study team with *Send feedback on the study* under the extension icon,
  or e-mail them, with what you did and what you saw; the service-worker log (`chrome://extensions`
  → Advice Tracker → *Inspect views: service worker*) helps if you are comfortable copying it.

## Updating and uninstalling

- **Update**: download the ZIP again, replace the contents of your folder (the same folder, in
  the same place and with the same name: do not delete it first), then on
  `chrome://extensions` click the circular reload arrow on the Advice Tracker card and reload
  your chat tabs. (The Web Store version will update itself.)
- **Uninstall / withdraw**: `chrome://extensions` → **Remove** on the card. To also wipe the local
  data first: Options → *Delete all data on this computer*.
