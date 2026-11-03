// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package catalogue defines the MCP tools: names, groups, schemas and
// annotations. Which tools are visible is decided by the add-on's settings.
package catalogue

// Tool describes one MCP tool.
type Tool struct {
	Name, Group, Description string
	Input                    map[string]any
	ReadOnly, Destructive    bool
	Idempotent               bool
}

type m = map[string]any

func str(desc string) m  { return m{"type": "string", "description": desc} }
func boolean(d string) m { return m{"type": "boolean", "description": d} }
func strs(desc string) m {
	return m{"type": "array", "items": m{"type": "string"}, "description": desc}
}
func date(desc string) m {
	return m{"type": "string", "pattern": `^\d{4}-\d{2}-\d{2}$`, "description": desc}
}
func enum(d string, v ...string) m {
	return m{"type": "string", "enum": v, "description": d}
}

// maxAttachments matches the host's limit on attachments per message.
const maxAttachments = 20

func attachments() m {
	a := strs("File names in the attachment folder; at most 20, 50 MiB in total.")
	a["maxItems"] = maxAttachments
	return a
}

func account() m { return str("Account id or name; optional when only one account is enabled.") }

func schema(required []string, props m) m {
	s := m{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

// bodyDesc tells callers how the plain-text body becomes the HTML message
// (addon/src/handlers/compose.js, textToHtml).
const bodyDesc = "Plain-text body. A blank line starts a new paragraph. A paragraph whose lines all start with \"- \" or \"* \" becomes a bulleted list, and one whose lines all start with \"1. \", \"2. \" and so on becomes a numbered list; an indented line continues the item above it. Put a blank line between a list and the text around it. With html set to true, the body is HTML instead."

// htmlDesc tells callers which HTML a body with html: true may use
// (addon/src/handlers/compose.js, cleanHtml).
const htmlDesc = "true when body is HTML rather than plain text. Allowed: p, br, ul, ol, li, strong, em (b and i become strong and em), a with an http, https or mailto href, and table, thead, tbody, tr, th, td (colspan and rowspan). Tables get a border and cell padding. Any other element keeps only its text; scripts, styles and images are removed, as are all other attributes. The signature and, for replies and forwards, the quoted original still follow the body."

// fromDesc tells callers how the sending identity is chosen
// (addon/src/handlers/compose.js, writer).
const fromDesc = "Identity to write from: its address or id. For a new message, one of the account's identities; with no account, the enabled account that has this identity. For a reply or forward, an identity of any enabled account. Without from, a reply or forward goes out from the identity the original was addressed to, in its own account first and then in any enabled account; for mail you sent, from the identity that sent it; otherwise from the account's default identity. A reply or forward from another account's identity is saved in that account's Drafts."

// sendFromDesc is fromDesc for mail_send, which writes only new messages.
const sendFromDesc = "Identity to send from: its address or id, one of the account's identities; the account's default identity when not given. With from and no account, the enabled account that has this identity."

func composeProps() m {
	return m{
		"account": account(),
		"from":    str(fromDesc),
		"kind": enum("new, reply, reply_all, reply_list or forward. reply_list answers the mailing list in the original's List-Post header, and is refused for a message without one.",
			"new", "reply", "reply_all", "reply_list", "forward"),
		"id":          str("Message id to reply to or forward."),
		"forward_as":  enum("For kind forward: inline (the default) quotes the original in the body with its attachments; attachment attaches the whole original message.", "inline", "attachment"),
		"to":          strs("To recipients."),
		"cc":          strs("Cc recipients."),
		"bcc":         strs("Bcc recipients."),
		"subject":     str("Subject; defaults to the original's for replies and forwards."),
		"body":        str(bodyDesc),
		"html":        boolean(htmlDesc),
		"attachments": attachments(),
	}
}

var tools = []Tool{
	{Name: "mail_accounts", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Lists the mail accounts the user has enabled: id, name, type, address (the default identity's), default (true for Thunderbird's default account) and identities, every sender identity of the account (id, email, name, label), the default one first with default: true.",
		Input:       schema(nil, m{})},
	{Name: "mail_folders", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Lists folders of an account, leaving out folders the user has excluded. In an account with excluded folders, a folder that has appeared since the user last checked the excluded folders in the options is left out until the user checks them again. Each folder has unread, total and new (messages that arrived since the folder was last looked at) counts, quota (the server's limits for the folder: type STORAGE in bytes or MESSAGE in messages, with limit, used and unused; empty when the server reports none), lastUsed (when Thunderbird last used the folder: the user opened it, or messages were moved, copied or delivered into it; null when Thunderbird has no date), favorite and specialUse. The counts, quota and lastUsed are null for a folder Thunderbird could not read or did not answer for in time, and a note then says which; only a late answer is worth asking again for.",
		Input:       schema(nil, m{"account": account()})},
	{Name: "mail_search", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Finds messages and returns headers only (id, from, subject, date, flags, tags, priority) and never returns message text; use mail_read for text. text and subject matching is case-sensitive in Thunderbird; from and to are not. Results come newest first and may be truncated; a truncated result has a note on how to narrow the search. hasAttachments is null when it could not be checked in time, and priority is null on Thunderbird before 148. text finds words in a message body only for mail whose body Thunderbird has stored offline (the account's Synchronization & Storage settings); other messages can still be found by from, to and subject. Some criteria are checked message by message, which is slower on a large mailbox: a from or to that is not a whole address, tags_mode untagged, to_me or from_me false, and to_me or from_me true while an account with an address is not enabled; since and until keep such a search quick.",
		Input: schema(nil, m{
			"account": account(), "text": str("Text to find in the message."),
			"from":    str("Sender. A whole address (bob@acme.com) matches that address; other text (acme.com, bob@, Smith) matches a sender whose name or address contains it."),
			"to":      str("Recipient (To, Cc or Bcc). A whole address matches that address; other text matches a recipient whose name or address contains it."),
			"subject": str("Subject contains."),
			"since":   date("On or after, YYYY-MM-DD."), "until": date("On or before, YYYY-MM-DD. Without it, mail dated in the future is found too."),
			"unread": boolean("Only unread (true) or only read (false)."), "flagged": boolean("Only flagged (true) or unflagged (false)."),
			"junk":    boolean("Only mail Thunderbird counts as junk (true) or only mail it does not (false)."),
			"to_me":   boolean("Only mail with one of the enabled accounts' addresses as a recipient (true), or only mail without (false)."),
			"from_me": boolean("Only mail sent from one of the enabled accounts' addresses (true), or only mail from other addresses (false)."),
			"tag":     str("Tag key or name."),
			"tags":    strs("Tag keys or names; tags_mode says how they combine with tag."),
			"tags_mode": enum("How tag and tags select mail: all (every tag, the default), any (at least one), none (none of them), or untagged (mail with no tag at all, checked message by message; give no tag or tags).",
				"all", "any", "none", "untagged"),
			"folder":         str("Folder path to search."),
			"subfolders":     boolean("With folder: also search its subfolders (true, the default) or the folder alone (false)."),
			"has_attachment": boolean("Only messages with attachments."),
			"limit":          m{"type": "integer", "minimum": 1, "maximum": 200, "default": 25, "description": "Maximum results."},
		})},
	{Name: "mail_read", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Returns one message's headers, plain-text body (wrapped as untrusted content) and attachments (name, size, content type, part and type). The body is the text a reader sees; plainTextDiffers is true when the message's plain-text alternative says something that text does not. An attachment's type is normal when the file is in the message; linked or cloudFile when the message only links to it, with the link in link; detached or deleted when the message keeps only a placeholder. mail_attachment fetches normal attachments only. At most 200 attachments are listed; attachmentsTruncated is true when there are more. Pass an attachment's part to mail_attachment when several attachments share its name or it has none. With headers set to true, allHeaders gives every header of the message, keyed by its lowercased name, except the blind-recipient headers (Bcc, Resent-Bcc and any other name ending in -bcc) and any name that is not printable ASCII (at most 200 values; allHeadersTruncated when more were left out).",
		Input: schema([]string{"id"}, m{
			"account": account(), "id": str("Message id from mail_search."),
			"max_chars": m{"type": "integer", "minimum": 1, "maximum": 50000, "default": 8000, "description": "Maximum body characters."},
			"headers":   boolean("true to also return every header of the message, such as List-Unsubscribe, Message-ID and Received, in allHeaders."),
		})},
	{Name: "mail_thread", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Returns the messages in the conversation of one message, oldest first, as pointers (id, from, subject, date, flags, tags, priority) only, never message text; use mail_read for text. truncated is true when Thunderbird was slow or the conversation is longer than the tool follows (200 messages, the 100 nearest earlier messages, the newest 200 later messages with the same subject); the newest messages are kept.",
		Input:       schema([]string{"id"}, m{"account": account(), "id": str("Message id from mail_search.")})},
	{Name: "mail_attachment", Group: "read",
		Description: "Returns a text attachment's text inline (wrapped as untrusted content; nothing is saved), or saves any other attachment to the user's attachment folder and returns its path. Give the attachment's name, its part from mail_read, or both. Attachments over 50 MiB are refused, and so are attachments that are not in the message (mail_read's type other than normal), since the message holds only a placeholder for them.",
		Input: schema([]string{"id"}, m{
			"account": account(), "id": str("Message id."), "name": str("Attachment file name; may be left out when part is given."),
			"part": str("Attachment part from mail_read; picks that attachment when several share the name, and fetches one that has no name."),
		})},
	{Name: "mail_filter_suggest", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Returns step-by-step instructions for making a message filter with these conditions and actions in Thunderbird's Message Filters window; it changes nothing.",
		Input: schema([]string{"account"}, m{
			"account": account(),
			"conditions": m{"type": "array", "items": schema([]string{"field", "op", "value"}, m{
				"field": enum("Field.", "from", "to", "subject", "body", "tag", "date"),
				"op":    enum("Operator.", "contains", "is", "begins", "ends", "before", "after"),
				"value": str("Value to compare."),
			})},
			"match": enum("all or any condition.", "all", "any"),
			"actions": m{"type": "array", "minItems": 1, "items": schema([]string{"type"}, m{
				"type":  enum("Action.", "move", "copy", "tag", "mark_read", "flag"),
				"value": str("Folder path or tag, where the action needs one."),
			})},
		})},
	{Name: "mail_tags", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Lists Thunderbird's tags: {tags: [{key, label, color}]}, color as #RRGGBB or null. Tags belong to the whole profile, not one account; refused with not_enabled while no account is enabled. mail_tag and mail_search take a key or a label; message lists show keys.",
		Input:       schema(nil, m{})},
	{Name: "mail_contacts", Group: "contacts", ReadOnly: true, Idempotent: true,
		Description: "Searches the user's address books and returns names and email addresses.",
		Input: schema([]string{"query"}, m{
			"account": account(), "query": str("Name or address fragment."),
			"limit": m{"type": "integer", "minimum": 1, "maximum": 200, "default": 25, "description": "Maximum results."},
		})},
	{Name: "mail_mark", Group: "organise", Idempotent: true,
		Description: "Sets read and flagged state on messages. Returns {done: ids changed, failed: [{id, code}]}.",
		Input: schema([]string{"ids"}, m{
			"account": account(), "ids": strs("Message ids."),
			"read": boolean("Mark read (true) or unread (false)."), "flagged": boolean("Flag (true) or unflag (false)."),
		})},
	{Name: "mail_tag", Group: "organise", Idempotent: true,
		Description: "Adds and removes tags (by key or label, as mail_tags lists them) on messages. Returns {done: ids changed, failed: [{id, code}]}.",
		Input: schema([]string{"ids"}, m{
			"account": account(), "ids": strs("Message ids."), "add": strs("Tags to add."), "remove": strs("Tags to remove."),
		})},
	{Name: "mail_move", Group: "organise",
		Description: "Moves or copies messages to another folder of the same account; refuses other accounts, excluded folders, Trash, Junk, the Outbox and a folder that cannot hold messages (use mail_trash to bin mail). A copy into the message's own folder fails with refused. Returns {done: ids changed, failed: [{id, code}], moved: [{from, to}]} (copied instead of moved with copy), where to is the message's id in the target folder; on IMAP it may take a moment to resolve.",
		Input: schema([]string{"ids", "folder"}, m{
			"account": account(), "ids": strs("Message ids."), "folder": str("Target folder path."),
			"copy": boolean("Copy instead of move."),
		})},
	{Name: "mail_archive", Group: "organise",
		Description: "Archives messages; Thunderbird picks the destination: the archive folder of the message's identity, or a year or month folder under it. Refused when any archive folder is in an account that is not enabled or is excluded. Returns {done, failed: [{id, code}], moved: [{from, to}]}: to is the archived message's new id, listed when Thunderbird reports it in time; a message already in its archive folder stays there, done with to the same id. Mail in a folder that cannot delete messages, such as a newsgroup or a read-only shared folder, is archived as a copy and listed under copied: [{from, to}] instead; the original stays. A message Thunderbird did not archive (archiving turned off for its identity) fails with not_enabled; one archived into an account or folder the settings do not allow fails with refused and mayHaveCompleted.",
		Input:       schema([]string{"ids"}, m{"account": account(), "ids": strs("Message ids.")})},
	{Name: "mail_trash", Group: "organise", Destructive: true,
		Description: "Moves messages to the account's Trash folder. Returns {done: ids changed, failed: [{id, code}], moved: [{from, to}]}, where to is the message's id in Trash.",
		Input:       schema([]string{"ids"}, m{"account": account(), "ids": strs("Message ids.")})},
	{Name: "mail_draft", Group: "compose",
		Description: "Saves a new message, reply or forward to Drafts without sending; replies and forwards keep their threading. The draft goes to the Drafts folder of the account it is written from. An account without a Drafts folder of its own saves to the Drafts folder of Local Folders, on this computer, when Local Folders is enabled, and is refused otherwise; a draft is never saved in another server account. A forward is refused when the original has an attachment that is only a placeholder in the message (a FileLink, or a linked, detached or deleted file); forward_as attachment forwards such a message whole. Returns draftId, the saved draft's message id.",
		Input:       schema([]string{"kind", "body"}, composeProps())},
	{Name: "mail_compose", Group: "compose",
		Description: "Opens a compose window in Thunderbird, filled in, for the user to review and send. Returns {opened: true, tabId, windowId}, the ids of the compose tab and window Thunderbird opened.",
		Input:       schema([]string{"kind", "body"}, composeProps())},
	{Name: "mail_send", Group: "send", Destructive: true,
		Description: "Sends a new message directly, and only to recipients on the user's allowed list; any other recipient refuses the whole message. Direct send accepts only simple addresses (letters, digits, . _ + -) before the @ and a plain ASCII domain; use mail_draft for any other address. Nothing is sent while Thunderbird is offline.",
		Input: schema([]string{"to", "subject", "body"}, m{
			"account": account(), "from": str(sendFromDesc), "to": strs("To recipients."), "cc": strs("Cc recipients."), "bcc": strs("Bcc recipients."),
			"subject": str("Subject."), "body": str(bodyDesc), "html": boolean(htmlDesc), "attachments": attachments(),
		})},
}

// All returns every tool in catalogue order.
func All() []Tool {
	out := make([]Tool, len(tools))
	copy(out, tools)
	return out
}

// Filter returns the tools whose names are listed, in catalogue order.
// Unknown names and duplicates are ignored.
func Filter(enabled []string) []Tool {
	want := map[string]bool{}
	for _, n := range enabled {
		want[n] = true
	}
	var out []Tool
	for _, t := range tools {
		if want[t.Name] {
			out = append(out, t)
		}
	}
	return out
}
