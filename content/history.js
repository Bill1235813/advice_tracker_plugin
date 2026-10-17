// Content script: reads the participant's conversation list and conversations from the chat site's
// own API, one request at a time, when the background worker asks for it (background.js historyStep;
// only while the participant agreed to it on the settings page and tracking is on). The page itself
// never starts a read, so a tab left over from before an update of the extension stays silent.
//   history_fetch {what: "list", cursor}     one page of the list, newest first: {page: {items, next}}
//   history_fetch {what: "read", id, windows} one conversation: {conversation} as lib/history.js
//                                             forWorker hands it over (turns that may not be read go
//                                             without their text), {gone} or {tooLong}
// Every answer says which account it was read with (a hash) and whether it is a personal one; an
// error answers {ok: false, status, retryAfterMs, blocked}.
// The site's reader (lib/history/<site>.js) does the requests; its credentials stay in this page's
// memory only.
(function () {
  const reader = self.HISTORY_READERS?.[location.hostname];
  if (!reader) return;
  const context = { fetch: (...args) => fetch(...args), document, location };
  let auth = null;

  // the reader's call, with credentials fetched once more if the site says they ran out (401)
  async function withAuth(call) {
    if (!auth) auth = await reader.auth(context);
    if (!auth) throw Object.assign(new Error("signed out"), { status: 401 });
    try {
      return await call(auth);
    } catch (error) {
      if (error.status !== 401) throw error;
      auth = await reader.auth(context);
      if (!auth) throw error;
      return call(auth);
    }
  }

  async function answer(message) {
    const result = message.what === "list"
      ? { page: await withAuth((credentials) => reader.list(context, credentials, message.cursor ?? null)) }
      : await readOne(message);
    // NOTE: [design thought] the account is told by a hash of its id only. A reader that knows the
    // account also says whether it is a personal one (a team or work workspace is never read). A reader
    // that cannot tell which account is signed in (Grok's) leaves both open: the worker then assumes
    // one account in this browser, and watches the list for a change of account (background.js)
    const known = Boolean(auth?.accountId);
    return { ok: true, account: known ? Episodes.hash(String(auth.accountId)) : null, accountKnown: known,
             personal: known ? auth.personal === true : auth?.personal !== false, ...result };
  }

  async function readOne(message) {
    const conversation = await withAuth((credentials) => reader.read(context, credentials, message.id));
    if (!conversation) return { gone: true };
    const url = `${location.origin}${reader.pathOf(message.id, conversation)}`;
    const forWorker = History.forWorker({ ...conversation, id: message.id, url }, message.windows);
    return forWorker ? { conversation: forWorker } : { tooLong: true, updatedAt: conversation.updatedAt };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "history_fetch") return undefined;
    answer(message).then(sendResponse, (error) => sendResponse({
      ok: false, status: error.status ?? 0, retryAfterMs: error.retryAfterMs ?? null,
      // a page instead of data (a challenge, a sign-in page): the site does not want to be read now
      blocked: error instanceof SyntaxError,
    }));
    return true;              // the answer comes later
  });
})();
