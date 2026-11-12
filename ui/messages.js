// The page of the messages for the participant (0.6.15): those the study team sent through the study server
// (background.js fetchTeamMessages) and the reminders the extension makes itself at the end of a study week
// (`automatic`, background.js weekCheck). The background keeps them (teamMessages: [{id, title, text, sentAt,
// receivedAt, readAt}]); this page lists them, the new ones first, then the read ones, newest first. "OK, I
// have read it" tells the background, which tells the study server. Opening the page also asks the server for
// messages that came since the last status signal.

// NOTE: [design thought] a message is the study team's own text, but it comes over the network: it is put on
// the page as text (createTextNode), never as HTML. Only an https address on one of these sites becomes a
// link (where the extension is downloaded from, the install guide, Prolific); any other address stays text.
const LINK_HOSTS = ["github.com", "docs.google.com", "drive.google.com", "app.prolific.com", "www.prolific.com"];

// The text as page nodes: plain text, with the addresses on LINK_HOSTS as links
function withLinks(text) {
  // NOTE: [pedagogical] split with a capturing group keeps the separators: the odd entries are the addresses
  return text.split(/(https:\/\/[^\s<>"']+)/).map((part, index) => {
    // (a period or bracket right after an address ends the sentence, not the address)
    const address = part.replace(/[.,;:!?)\]]+$/, "");
    let host = "";
    try { host = index % 2 ? new URL(address).hostname : ""; } catch (error) { /* not an address after all */ }
    if (!LINK_HOSTS.includes(host)) return document.createTextNode(part);
    const link = document.createElement("a");
    link.href = address;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = address;
    const nodes = document.createDocumentFragment();
    nodes.append(link, document.createTextNode(part.slice(address.length)));
    return nodes;
  });
}

function messageCard(message) {
  const card = document.createElement("div");
  card.className = `card${message.readAt ? "" : " new"}`;
  card.id = `message-${message.id}`;
  const when = (at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  card.innerHTML = '<h2></h2><p class="message-text"></p><p class="meta"></p>';
  card.querySelector("h2").textContent = message.title || "A message from the study team";
  card.querySelector(".message-text").append(...withLinks(message.text));
  // (a reminder the extension made itself says so)
  card.querySelector(".meta").textContent = (message.automatic ? "Automatic reminder of the extension · " : "") +
    (message.readAt ? `Received ${when(message.receivedAt)} · read ${when(message.readAt)}` : `Received ${when(message.receivedAt)}`);
  if (!message.readAt) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ok";
    button.textContent = "OK, I have read it";
    button.onclick = async () => {
      button.disabled = true;
      // (the background marks it as read; the storage listener below then draws the list again)
      await chrome.runtime.sendMessage({ type: "message_read", id: message.id, where: "page" });
    };
    card.append(button);
  }
  return card;
}

async function render() {
  const { teamMessages = [] } = await chrome.storage.local.get("teamMessages");
  const newestFirst = [...teamMessages].sort((a, b) => b.receivedAt - a.receivedAt);
  const list = document.getElementById("list");
  list.replaceChildren(...newestFirst.filter((message) => !message.readAt).map(messageCard),
                       ...newestFirst.filter((message) => message.readAt).map(messageCard));
  if (!teamMessages.length) list.innerHTML = '<div class="card"><p class="empty">No messages from the study team.</p></div>';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.teamMessages) render();
});
render();
chrome.runtime.sendMessage({ type: "check_messages" });
