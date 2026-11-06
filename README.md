# Advice Tracker (research study extension)

A Chrome extension used in a university research study on how people ask AI chat assistants
(ChatGPT, Claude, Gemini, Grok, Perplexity) for advice about their own lives, and what happens
afterwards. When part of a conversation looks like you asked the AI for advice about your own
situation, the extension asks whether you really asked for advice, and then a few questions about
the advice (about 5 to 10 minutes; when it asks is explained below). From a week later it asks
whether you made a decision and acted on it, and then how things went. Your answers stay on your computer until you press **Submit**; they are then sent
together with that advice conversation (your messages and the AI's replies, from your message that
asked for advice on), after names, e-mail addresses, phone numbers and similar details were removed
on your computer.

This folder is the extension itself, so it can be loaded straight into Chrome. A Chrome Web Store
version (one-click install) is in preparation; until then, follow the steps below.

**How it works, in detail:** [`docs/advice-tracker-design.pdf`](docs/advice-tracker-design.pdf).

## What's new in version 0.6.11 (v0.6 branch)

- **Conversations from other devices are always found**, without an option to turn on: advice
  conversations you have after joining in the sites' phone or desktop apps, or in another browser,
  are asked about like those on the web. If you had not turned this on before the update, only what
  you write from the update on is read, and the settings page opens once to say so.
- **Past conversations: one click.** On the settings page, one box, "I agree: read my past
  conversations", turns them on, next to the text it agrees to, and is saved at once (no separate
  "I agree" box, no Save); another click turns them off. "Delete all data" turns past conversations
  off; other devices are still read after it, from the deletion on.
- **Up to 30 past conversations, per participant ID, counted by conversation.** A conversation
  counts once, whichever of its messages was taken as the request (on another computer, or after
  past conversations were turned off and on again), and is not asked about twice. If two computers
  with the same participant ID find past conversations at the same time, the ones waiting on one
  computer that would bring the total over 30 are removed once the other computer's annotations
  are known (checked every hour), the ones found last first. One found while the 30th was annotated
  elsewhere is not added, and one you answered No to no longer counts while it is being removed.
- **A past annotation is not lost when Chrome quits while it is being sent:** your answers go into the
  upload queue first and are sent from there (one left half done is finished at the next start). Before,
  such an annotation was never sent, and its site's past conversations stopped being offered.
- **"Yes" on a past conversation asks the study server again** which ones your participant ID annotated
  (besides the hourly check), so another computer's annotations since then are counted before you
  start; the one you are annotating is the last to be removed over the limit. If a past conversation
  was removed while you were answering, the page now says your answers were not sent (it said "sent").
- Half of an emoji (where a long reply read from a site was cut) is never sent: the study server
  refused such an event every time, so it was retried every 30 minutes and never recorded. Replies are
  cut on a whole character, and any other half character is replaced before sending.
- Because every install now reads the sites, a message you send on the web right after messages the
  web page did not see you send (in an older conversation you continue, or one from your phone) is
  checked once that conversation was read from the site, as it already was when other devices were
  turned on: usually within seconds, at most two minutes if the reading makes no progress. It no
  longer waits at all when the site cannot be read now (reading stopped or paused there, switched off
  by the study team, or this conversation failed to read).
  A web advice conversation that goes quiet for a day ends a little later than before, usually within
  minutes (it is first handed to the reading, in case it went on in an app).
- Data notes: `consent` events are sent only for past conversations (`read_past`); the status
  report's `read_apps` is always true. The consent text's version is `draft-2026-11-06`. A past
  episode removed over the limit is counted as `past_over_limit`. For payment, count distinct
  conversations per participant ID (a `past_annotation` fingerprint's part before the first "-"),
  at most 30: a resend after a lost server answer can repeat an event, and two computers annotating
  in the same minutes can still pass 30.

## What's new in version 0.6.10 (v0.6 branch)

Fixes to 0.6.9's follow-up, found in two rounds of review:
- **"Did you act on this decision yet?"** is asked again on the day you planned to act, and whenever
  it comes up again, on the Outcomes page as in the pop-up (0.6.9's page asked only when you plan to
  act, so you could not say you had). "When do you plan to act?" follows right after "Not yet".
- A minimized follow-up bar no longer keeps later follow-up questions off its tab (the chat sites do
  not reload when you switch conversations); after "Later", the bar opened again still works.
- The follow-up's buttons take one answer each (a double click no longer answers twice, or the next
  question too).
- A check-in from before 0.6.9 shows its date on the Outcomes page (it said "Invalid Date").
- Each page shows its own waiting conversation per site: past ones on the Outcomes page, those from
  other devices on the quick check-ins page; while a question of the other kind waits on a site, a
  page's card does not change the order the chat page asks in (other devices first); "1/N awaiting
  labeling" counts only those that wait for an answer.
- The Outcomes reminder does not come when you opened the page in the last two days (a reminder you
  clicked included); it does when the visit was longer ago, also after Chrome was closed for days.
- Past conversations: one you annotated on an earlier install or another computer is not asked about
  again (also one already found here: the list is asked for every hour while past conversations are
  read); past turns wait until the study server said which ones your participant ID annotated (also in
  conversations read for other devices), and until it said when you joined; changing the participant ID
  asks again.
- Data note: every follow-up answer is uploaded as given, so a "not yet" answered again later (on
  another day, or on a page opened later) is a second `followup` event; only the same answer within a
  minute (a double click, two tabs) counts once.
- ChatGPT: the reply to a prompt ChatGPT sent for you is not read also when your message before it got
  only a picture as its answer.
- Your one-sentence description of a conversation stays off the pages of other chat sites, also when the
  tab moved to another site meanwhile.
- The extension's description no longer says "two weeks later" (and fits Chrome's 132 characters).

## What's new in version 0.6.9

- **A follow-up instead of the two-week check-in.** From a week after you asked the AI for advice
  (when that conversation is over at the latest), a small pop-up on a chat site's page asks about it:
  **"Did you make a decision yet?"** Not yet: it minimizes, and asks again the next day. Yes: **"Did
  you act on this decision yet?"** If you did, a few questions about how it turned out follow (on
  the Outcomes page). If not yet, it asks when you plan to: within the study period (five weeks from
  when you joined), it asks again then; later than that, or if you are not sure, the questions about
  how things stand come now. On the study period's last day they come for every conversation still
  open. The pop-up names the conversation by its site and date, and by your own one-sentence
  description of it only on that site's own page. Leave it alone and it minimizes by itself.
- **Two pages instead of one.** *Quick check-ins* (extension icon → Quick check-ins): the questions
  about the conversations you are having now, what counts as personal advice, and free support
  resources. The new *Outcomes* page (extension icon → Outcomes): every advice conversation whose
  follow-up is not finished, oldest first, each at its question (the same as the pop-up's) or with
  its outcome questions; everything about past conversations (their questions, and how reading
  them goes); and free support resources. While a follow-up question waits, a Chrome notification
  reminds you of the Outcomes page every two days (not if you opened it meanwhile).
- "Did the advice you followed make you feel better?" is now the statement **"Following the advice
  made me feel better."**, answered on the same agree/disagree scale.
- **Up to 30 past conversations per participant, not per install.** The study server tells the
  extension which past conversations your participant ID annotated, on any computer or earlier
  install; they count toward the 30. (Past conversations are looked for once the server answered.)
- **ChatGPT, past and other-device conversations:** the reply to a prompt ChatGPT sent for you (a
  scheduled task, a button) is no longer read as part of the reply before it, as on Grok since 0.6.8.
- An upload the study server refuses for itself (for example, one too large) is tried again twice,
  30 minutes apart, and then dropped (the heartbeat counts it); any other failure is tried until it
  goes.
- For testing: the settings page's follow-up time is now when the follow-up begins (604800 s = 7
  days, the study's setting). An install updated from an earlier version with the old default (14
  days) moves to 7; a time you typed stays. A check-in made before 0.6.9 keeps its day.

## What's new in version 0.6.8

- **Answers that no longer apply are cleared.** Ticking "It is too early to tell" clears and locks
  "So far, how has the situation turned out?" (both were sent before); "Did the advice you followed
  make you feel better?" appears only when you followed the advice, and is cleared when you change
  that answer; "No one" cannot be ticked together with someone you asked. This applies to the
  two-week check-in and to past conversations.
- **One check-in per conversation.** A check-in submitted in two tabs is sent once; the other tab
  says it was answered, and questions about a conversation that its check-in completed say so too.
- **Nothing is sent without a participant ID**: an answer given then waits, and is sent with the
  ID once it is saved.
- The settings page refuses a quiet time below 1 minute or above a week (0 or less ended every
  advice conversation at once). The popup counts the same waiting questions as the icon's badge.
- A past conversation found later is no longer counted as a "later, related" conversation of an
  older one.
- **Reading past and other-device conversations:** a pause asked for by Gemini no longer ends the
  reading of older conversations; a Claude conversation is deleted from the computer only when Claude
  says it was deleted (not on an unrelated error); a refresh of the Claude list goes past its second
  page; on Grok, the reply to a message written by Grok itself (a scheduled task) is not read.

## What's new in version 0.6.7

- **Up to 30 past conversations** can be annotated ($2 each, up to $60), as the study's IRB
  protocol says; it was 20 ($40).

## What's new in version 0.6.6

- **Past and other-device conversations are read from any account**, a work, school or team one
  too (a ChatGPT or Claude workspace, a Google Workspace account on Gemini, a Perplexity Enterprise
  account): it was a personal account only (on Gemini, only a gmail.com address). As before, only
  the account first read on a site is read; while another account or workspace is open there, that
  site's reading stops.
- **What counts as advice:** the study's definition, with examples, on the check-in page, linked
  from the settings page and from every "Did you ask for advice here?".
- **Where reading stands:** the check-in page shows, for each site, how reading its conversations
  goes and why it stopped, and how many past conversations wait to be annotated.
- **A reminder while paused:** after 5 days of paused tracking, a Chrome notification with a
  "Resume tracking" button, again every 5 days while paused.
- **ChatGPT:** past conversations of a personal account are read again (a new cookie format made
  them look like a workspace's).

## What's new in version 0.6.5

- **The study server moved to university computers**, next to the study's AI model (it ran on
  a hosted service). A new install uses its new address; an install updated from an earlier
  version that still has the old address moves to the new one by itself. An address typed under
  "Advanced" on the settings page stays.

## What's new in version 0.6.4

- **The study's way of asking is now *Combined*** (it was *Switching*): right after the assistant's
  first answer to an advice message, a small pop-up asks only "Did you ask for advice here?", and
  the questions come at a 3-minute pause, a move to another conversation or a change of topic,
  whichever is first (more under "What's new in version 0.4.2"). A new install starts with it; an
  install updated from an earlier version keeps the way of asking it had, which its settings page
  shows and can change.

## What's new in version 0.6.3

- **Scrolling up in a long conversation no longer asks again.** When older messages load above as
  you scroll up and one of them repeats a question you asked here (the same question asked a month
  before, say), the extension no longer takes the older one for yours: it does not ask about your
  question again, also after its questions have ended, and the conversation sent with your answers
  is the right one. Editing one of those older messages, or a message below them into a text that
  repeats an earlier one, is followed correctly too.

## What's new in version 0.6.2

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
    of the two-week check-in. **You can earn $2 for each past conversation you annotate** (up to 30).
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
  site you excluded; messages you send then are never processed, not even later. If tracking stays
  paused for 5 days, a Chrome notification reminds you, with a "Resume tracking" button; it comes
  again every 5 days while paused.
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

- **A fourth way of asking, *Combined***, chosen in the settings like the other three (the default
  since 0.6.4):
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
  - *Switching* (the default until 0.6.4): when you move to another conversation, a first set of
    answers you can update later; when you change the topic, your final answers.
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
2. With the default *Combined* mode, a small pop-up asks only "Did you ask for advice here?" right
   after the assistant's first answer, and the panel comes after 3 minutes without typing, a new
   chat, or a change of subject (*"Unrelated: what is the capital of Peru?"*), whichever is first.
   With *Switching*, start a new chat (the panel asks for a first set of answers) or change the
   subject in the same chat (the panel asks for your final answers). With *Frequent*, the panel
   appears right after the assistant's first answer; with *Periodical*, after 3 minutes without
   typing.
3. A small **Quick check-in** panel appears at the bottom right of the chat page. The panel
   quotes your request and asks **"Did you ask for advice here?"** (in *Combined* mode only if you
   did not answer Yes in the pop-up).
4. Click **Yes**, answer all the questions (each one is required), and press **Submit**. Your
   answers are sent with the conversation, after personal details were removed on your computer.
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
- **Other devices, and past conversations (only if you turned them on with one click on the settings
  page):** the extension reads your conversation list and conversations through the
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
  your answers about it (for a past one, the conversation is shown to you as it will be sent).
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
  wait for an answer are listed under the extension icon → **Quick check-ins** and **Outcomes**.
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

- `manifest.json` (Manifest V3, version 0.6.10): permissions `storage`, `unlimitedStorage` (no
  install warning), `alarms`, `notifications`, and host permissions for the five chat sites (plus
  `localhost` for the mock test page); no remote code.
- Past and other-device conversations (0.6, opt-in): `content/history.js` answers the worker's
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
  them to the current server).
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
  `card`. 0.6.8: an answer to a question that does not apply is `null` (`outcome` when `too_early` is
  ticked, `feel_better` unless `followed` is `fully` or `partly`). 0.6.9: `followup` (each answer to
  the follow-up's questions: `step` decided, acted or when, `answer`, `where` popup or page, the
  `stage` after it, `days_since_request`, `next_at`, `planned_at`, `shown`, `study_end`; no text),
  `checkin.followup` (`ask_from`, `due_at`, `shown`, and the answers with their times: `decided`,
  `decidedAt`, `acted`, `actedAt`, `actWhen`, `plannedAt`), the heartbeat's `followup_stages` and
  counts `upload_rejected`, `upload_rejected_<type>`; the extension asks `GET /past?participant_id=`
  (study server 0.6.1) for the fingerprints of the past conversations the participant ID annotated,
  on any install. 0.6.2: a `prompt` can also end `withdrawn` (the pop-up or invitation was taken away because
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
