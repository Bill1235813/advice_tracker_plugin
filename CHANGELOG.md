# Changelog

What changed in each version of the Advice Tracker extension, newest first: for participants, and in
the *Data notes* for the study team. How to install and use it: [README.md](README.md).

## 0.6.15

A reminder at the end of each study week, messages from the study team, numbered labels for
personal details, and the rules as the consent form reads since November 11.

- **A reminder at the end of a study week, sent by the extension itself.** A payment needs you to
  have been active in its time (each of weeks 1 to 3; weeks 4 and 5 together) and to have finished
  the due tasks. At the end of weeks 1, 2 and 3 and of week 5 the extension looks at what it holds:
  were you active (an advice conversation, answers to its questions, feedback), and are due tasks
  left: in weeks 1 to 3 the quick questions that wait for you on the Quick check-ins page (advice
  conversations you never answered; not one still going on that you were not asked about yet), at
  the end of week 5 the outcome questions. If something is missing, a reminder says what, and by which day
  to finish (three days later); it shows as a notification, in a small window on your AI chat
  pages and under the extension icon, until you click **OK, I have read it**. Outcome questions
  are never counted as due before the end of week 5, and past conversations never. If Chrome was
  closed when the week ended, the reminder comes at its next start (not once its three days are
  over).
- **Messages from the study team.** The study team can also send you a message through the extension:
  a request to update, a note about your participation. After each
  heartbeat (twice a day), and when you open the messages page, the extension asks the study
  server whether there is one for your participant ID. A new message shows as a Chrome
  notification, in a small window at the top right of your AI chat pages (also while tracking is
  paused; never on a site you excluded), and in the menu under the extension icon, until you click
  **OK, I have read it**; the number on the icon counts it. *Messages from the study team*, under
  the icon, lists them all. A message is shown as plain text.
- **Numbered labels for personal details.** In what the study stores (your answers, the
  conversations sent with them, your feedback), the same detail now gets the same numbered label
  wherever it comes up: `[NAME1]`, `[NAME2]`, `[EMAIL1]`, ... instead of `[NAME]` and `[EMAIL]`
  everywhere. Capitals do not matter (`Emma`, `EMMA` and a listed `emma` are one name); a typo, a
  nickname, or a first name alone after the full name counts as another. The numbers are your own,
  and come from a table kept on your computer only, with a fingerprint of each detail, not the
  detail itself; "Delete all data" empties it. A past conversation's card shows the conversation
  with these labels, exactly as it will be sent.
- **The outcome questions.** The first one is now "Did you follow or plan to follow the advice?",
  with the answers "Yes, the AI reinforced my initial decision, and I followed my initial
  decision", "Yes, the AI changed my decision somehow", "Yes, but only partly", "No, I decided
  against it" and "No, the situation changed or resolved itself"; the second one asks "What did
  you actually do, or decide, and why?". The same holds for past conversations.
- **Study rules as in the current consent form.** Not active at the end of the 3 days after a
  reminder: the week's payment ($10) is lost. Late answers: paid in proportion; in week 5 out of
  all conversations after the start of the study. Not active or late in any week: no high-quality
  bonus. Past conversations are paid when answered on time (by the end of week 5), and are not
  among the week's due tasks. The details of participation ending after week 3 are gone, as in the
  form.
- **The reminder of your Outcomes page** (every two days) says by when the outcome questions are
  due only in the last week of your study, when they are due; before, it asks without a deadline.
- **Install guide.** Keep the extension's folder where it is for the whole study (do not delete,
  move or rename it), and how to pin the icon, with a picture.
- Data notes: uploaded texts (`transcript`, free-text answers, feedback `text`) carry numbered
  placeholders, per participant and install (`[NAME1]`, `[file: NAME1_cv.pdf]`); the `redacted`
  counts are unchanged, and `POST /judge` still gets the placeholders without numbers. `checkin`
  and `past_annotation` answers: `followed` is one of `reinforced`, `ai_changed`, `partly`,
  `against`, `changed` (before: `fully`, `partly`, `plan`, `against`, `changed`, `forgot`), and
  `feel_better` is asked after the first three. New event `team_message` (`message`: the id,
  `state` `received` or `read`, with `where` and `seconds_waited` when read; `automatic: true`
  for the extension's own reminder, whose `message` is `week-1`, `week-2`, `week-3` or
  `week-4-5`); the heartbeat carries `unread_messages`. New event `week_status`: what the extension
  found at the end of a paid part of the study and three days later (`week`, `moment` `end` or
  `deadline`, `ended_at`, `deadline_at`, `active`, `active_by` {`advice`, `answers`, `feedback`},
  `due_left`, `reminded`, `active_after_end`): for the study team's decision about the payment,
  which the extension does not make. The extension asks
  `GET /messages?participant_id=&version=`, which the study server answers from relay 0.6.2 on (an
  older server answers 404: no messages from the team; the automatic reminder needs no server
  change). "Delete all data" keeps the messages, what was found at each week's end, and the times
  feedback was sent.

## 0.6.14

The study's updated rules (payments, reminders, pauses), as in the updated consent form.

- **The study's five weeks**, counted from when you saved your Participant ID. New advice
  conversations are collected until the end of week 3: a message sent later is no longer checked,
  and nothing of it goes to the study server, unless it continues an advice conversation that began
  before. Such a conversation is followed until the end of week 4 at the latest. The follow-up
  questions go on until the end of week 5. The menu under the extension icon shows your week.
  (Past conversations, if you turned them on, are still found after week 3.)
- **Study rules page.** *Study rules: payments and participation*, under the extension icon and on
  the settings page, shows your own calendar (when each week ends, when its payment comes, when the
  extension stops collecting) and the rules for payments, reminders, quality review, late answers,
  pauses and the end of participation.
- **The follow-up, every two days.** "Not decided yet" is asked again two days later (the next day
  before), and the pop-up about one conversation comes at most every two days. A decision you plan
  to act on after the study, or do not know when, no longer brings the outcome questions at once:
  it stays on your Outcomes page and is asked about again.
- **Too early to tell.** When the outcome questions are ready and it is too early to tell how
  things turned out, one click ("Too early to tell: ask me again in 2 days", on the Outcomes page
  or in the pop-up) puts them off by two days; the conversation stays on your Outcomes page, and
  "I can tell now" brings the questions back at once. The form itself no longer has the "It is too
  early to tell" box, except in the study's last week and for past conversations.
- **Week 5: everything is due.** In the last week of your study the outcome questions of every
  advice conversation are open, whatever your answers so far (before: on the last day), and the
  pages say by when they are due. Nothing puts them off then.
- **The reminder every two days** now comes while anything on your Outcomes page is unanswered: a
  conversation you have not decided about, a decision not acted on, outcome questions not answered
  or too early to tell, a past conversation. It says: "Please check your Outcomes page for
  unanswered questions: Have you decided or acted? Did you get an outcome?". No reminder once
  everything is answered.
- **Past conversations are due by the end of week 5**; the pages say so, and ask you to answer them
  early, while you remember the details. One never answered is kept on your computer for 42 days
  (30 before), so it does not disappear before the study ends.
- **Past conversations: No or Skip.** The card and the invitation now say to answer **No** when a
  past conversation was not advice (it is then sent with your No, with personal details removed,
  so the study sees what the extension got wrong), and to use **Skip** for one you do not want to
  annotate (nothing of it is sent). They said "No or Skip if it was not advice".
- **Pausing shows the rules first.** *Pause tracking* under the extension icon opens a box with
  what a pause means (under 12 hours: nothing; 12 to 24 hours: a reminder; 24 hours to 1 week: that
  week's payment is reduced for the time paused; over 1 week: participation ends), and only
  *Pause tracking now* pauses. The settings page shows the same while its box is ticked. A reminder
  comes after 12 hours of pause and at every full day of it (every day before), and says which of
  these holds.
- **Report an advice conversation we missed**, under the extension icon: the feedback box, for a
  conversation in which you asked for advice and the extension did not ask you about.
- **Updating answers is encouraged, not required**; the pages say so, and that the study team
  reviews answers later. After **No** the page says "We will not ask about this conversation again"
  (it said the conversation "was removed from the study", though it is sent with your No since
  0.6.12).
- **How long you take to answer** each set of questions is sent with the answers, and **when you
  last sent a message** to one of the five AI assistants goes with the twice-daily heartbeat (the
  time only, never the text).
- Two notifications still said "about 5-10 min" for the quick questions: about 1 to 2 minutes.
- Data notes: `episode_rating`, `checkin` and `past_annotation` carry `timing` (`shown_at`,
  `first_answer_at`, `last_answer_at`, `submitted_at`, `seconds` from the first answer finished to
  the last; `null` from a page older than this version). `checkin.followup` gains `final_call`,
  `tooEarly`, `tooEarlyAt`, and `checkin.answers.too_early` is `[]` when the form had the button.
  `followup` events have a new `step` `outcome` (`answer` `early` or `yes`) and carry `due_at` and
  `too_early`; `when` answers no longer set `due_at`. The heartbeat carries `last_message_at`.
  `feedback` carries `kind` (`feedback` or `missed_advice`; count `feedback_missed_advice`).
  `consent` events carry the text's version `2026-11-10c` (the settings page says when past
  conversations are due). `config.js`: `newAdviceDays` 21, `continueDays` 28,
  `pausedReminderHours` 12 (`pausedReminderDays` is gone). The study server needs no change.

## 0.6.13

- **The times the extension states match the consent form**: about 1 to 2 minutes for the quick
  questions (the questions panel, "Rate this advice conversation now?", a conversation from another
  device), about 4 to 8 minutes for the outcome questions (the follow-up's pop-up) and for each past
  conversation (its invitation, its card, the settings page). They said 5 to 10 minutes, or about 5.
  Data notes: `consent` events carry the text's version `2026-11-10b` (the settings page's sentence
  about a past conversation's time changed).

## 0.6.12

- **Your Participant ID is your Prolific ID**, as the settings page now says. The research team's
  settings (the study server, the follow-up time, and how long a conversation must be quiet to
  count as finished) are no longer shown there; the study team opens
  `options/options.html?advanced` for a test.
- **An advice conversation lasts until you change the topic, or until a week after you first
  asked.** A day without activity no longer ends it, so coming back to it within the week
  continues it; if you wrote more in it after your answers, the final questions come when it
  ends. An install updated from an earlier version that still has the old default (a day) moves
  to a week; a time the study team typed for a test stays.
- **Feedback.** *Send feedback on the study*, under the extension icon right below *Show captured
  messages on this tab*, opens a box for anything you want the study team to know. It is sent with
  your participant ID, with names on your list, e-mail addresses, phone numbers and similar details
  replaced on your computer first; without a connection or a participant ID it waits and goes
  later. A draft stays while Chrome is open, if the menu closes before you send it.
- **A conversation you label "No" is sent with that label.** Until now a No deleted the
  conversation and sent only the fact; now the part the model took for advice goes with the No,
  redacted exactly as it would go with your answers, from the message taken as the request on (a
  past one too; a skipped past conversation still sends nothing). The study team can then see what
  the advice model took for advice and participants did not. The settings page says so.
- **The settings page's consent text is the release wording**: no DRAFT note and no note for the
  study team on it. Data notes: `consent` events carry the text's version `2026-11-10` (was
  `draft-2026-11-06`, which 0dc9464's added sentence about a No had kept).

## 0.6.11

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

## 0.6.10

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

## 0.6.9

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

## 0.6.8

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

## 0.6.7

- **Up to 30 past conversations** can be annotated ($2 each, up to $60), as the study's IRB
  protocol says; it was 20 ($40).

## 0.6.6

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

## 0.6.5

- **The study server moved to university computers**, next to the study's AI model (it ran on
  a hosted service). A new install uses its new address; an install updated from an earlier
  version that still has the old address moves to the new one by itself. An address typed under
  "Advanced" on the settings page stays.

## 0.6.4

- **The study's way of asking is now *Combined*** (it was *Switching*): right after the assistant's
  first answer to an advice message, a small pop-up asks only "Did you ask for advice here?", and
  the questions come at a 3-minute pause, a move to another conversation or a change of topic,
  whichever is first (more under "What's new in version 0.4.2"). A new install starts with it; an
  install updated from an earlier version keeps the way of asking it had, which its settings page
  shows and can change.

## 0.6.3

- **Scrolling up in a long conversation no longer asks again.** When older messages load above as
  you scroll up and one of them repeats a question you asked here (the same question asked a month
  before, say), the extension no longer takes the older one for yours: it does not ask about your
  question again, also after its questions have ended, and the conversation sent with your answers
  is the right one. Editing one of those older messages, or a message below them into a text that
  repeats an earlier one, is followed correctly too.

## 0.6.2

- **Asked again only after you write more.** In every mode, your answers are asked again (an
  update, or the final answers) only when you have written more in that conversation since you
  answered. A 3-minute pause, a move to another conversation, a change of topic or the one-week cut
  alone asks nothing; if nothing was added since your last answers, they count as your final ones.
  An update pop-up left on a tab in the background goes away once you answer elsewhere, and a
  reminder notification goes away once its question is answered.

## 0.6.1

- **For testing**: the settings page sets the time until the follow-up check-in in seconds
  (1209600 = 14 days, the study's setting), so a tester can bring the check-in, and the questions
  about past conversations, within minutes. Participants keep the default. The time counts from the
  first advice request and applies to conversations first answered after the change. With a short
  time, a question left unanswered that long is deleted at the next browser start or extension
  reload, the check-in can come while the conversation is still going on (answering it then skips
  the final answers at a change of topic), and a conversation from another device still gets its
  check-in a week after its first answers; the one-week cut stays 7 days.

## 0.6.0

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

## 0.5.0

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
  paused for a day, a Chrome notification reminds you, with a "Resume tracking" button; it comes
  again every day while paused.
- **No skipping.** The questions panel has no ✕ until you have answered once; you can still put it
  off with "later (1 h)", or answer "No" if you did not ask for advice (this removes the
  conversation from the study).
- **The study team sees whether tracking is on**: twice a day, and whenever it changes, the
  extension reports whether tracking is paused and on which of the five sites it can capture (a
  site you excluded in the settings, or whose access you withheld in Chrome, does not count). When
  the extension is removed, Chrome opens a page of the study server that records it.
- "Show captured messages on this tab" (popup) now counts all your captured messages in the
  conversation, also after you went to another chat and came back.

## 0.4.2

- **A fourth way of asking, *Combined***, chosen in the settings like the other three (the default
  since 0.6.4):
  - Right after the assistant's first answer to an advice message, a small pop-up asks only
    **"Did you ask for advice here?"** (No removes the conversation, as on the panel). It closes
    by itself after 30 seconds; if you do not answer it, the panel asks it again later.
  - The questions panel comes at whichever happens first: a 3-minute pause, a move to another
    conversation, or a change of topic. After Yes in the pop-up, it starts with the ratings.
  - Later pauses and moves offer an update in the small pop-up (only if the conversation went on
    since); a change of topic asks for your final answers, as in *Switching*.

## 0.4.1

- **Every question must be answered** before you can submit (two check-in questions only when
  they apply).
- **No "what to share" choice any more.** Submitting your answers sends the answers only. The
  conversation stays on your computer until the two-week check-in, which shows it with names, e-mail
  addresses, phone numbers and similar details removed; you can delete anything else in it, and it
  is sent when you submit the check-in.
- The check-in page lists free support resources.
- The settings page asks for the study code from the onboarding survey as your Participant ID.

## 0.4

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

## 0.3

- Each message you send is checked as it arrives, so one chat can contain several advice
  conversations (for example a career question, then a coding task, then a family question).
- The questions appear when an advice conversation **ends**: when you change the subject, after
  10 minutes without activity, or when you close the tab.
- The first question is **"Did you ask for advice here?"**. Answering "No" deletes the
  conversation from your computer. After "Yes" come three ratings (helpful, trust, potentially
  harmful) instead of six; you also pick the area of life yourself (9 options, optional).
- Old chats that you only open are never processed, even when you scroll through them.
