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
const fromDesc = "Identity to write from: its address or id, one of the account's identities. Without it, a reply or forward goes out from the identity the original was addressed to, and anything else from the account's default identity. With from and no account, the enabled account that has this identity."

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
		Description: "Lists the mail accounts the user has enabled, with their ids and identities.",
		Input:       schema(nil, m{})},
	{Name: "mail_folders", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Lists folders of an account with unread and total counts, leaving out folders the user has excluded.",
		Input:       schema(nil, m{"account": account()})},
	{Name: "mail_search", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Finds messages and returns headers only (id, from, subject, date, flags, tags) and never returns message text; use mail_read for text. Text matching is case-sensitive in Thunderbird, and results come newest first and may be truncated, with a note on how to narrow the search. hasAttachments is null when it could not be checked in time. text finds words in a message body only for mail whose body Thunderbird has stored offline (the account's Synchronization & Storage settings); other messages can still be found by from, to and subject.",
		Input: schema(nil, m{
			"account": account(), "text": str("Text to find in the message."), "from": str("Sender contains."),
			"to": str("Recipient contains."), "subject": str("Subject contains."),
			"since": date("On or after, YYYY-MM-DD."), "until": date("On or before, YYYY-MM-DD."),
			"unread": boolean("Only unread (true) or only read (false)."), "flagged": boolean("Only flagged (true) or unflagged (false)."),
			"tag": str("Tag key."), "folder": str("Folder path to search."),
			"has_attachment": boolean("Only messages with attachments."),
			"limit":          m{"type": "integer", "minimum": 1, "maximum": 200, "default": 25, "description": "Maximum results."},
		})},
	{Name: "mail_read", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Returns one message's headers, plain-text body (wrapped as untrusted content) and attachments (name, size, content type and part). The body is the text a reader sees; plainTextDiffers is true when the message's plain-text alternative says something that text does not. Pass an attachment's part to mail_attachment when several attachments share its name.",
		Input: schema([]string{"id"}, m{
			"account": account(), "id": str("Message id from mail_search."),
			"max_chars": m{"type": "integer", "minimum": 1, "maximum": 50000, "default": 8000, "description": "Maximum body characters."},
		})},
	{Name: "mail_thread", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Returns the messages in the conversation of one message as pointers (id, from, subject, date, flags, tags) only, never message text; use mail_read for text. It may be marked truncated if Thunderbird was slow.",
		Input:       schema([]string{"id"}, m{"account": account(), "id": str("Message id from mail_search.")})},
	{Name: "mail_attachment", Group: "read",
		Description: "Returns a text attachment's text inline (wrapped as untrusted content; nothing is saved), or saves any other attachment to the user's attachment folder and returns its path. Attachments over 50 MiB are refused.",
		Input: schema([]string{"id", "name"}, m{
			"account": account(), "id": str("Message id."), "name": str("Attachment file name."),
			"part": str("Attachment part from mail_read; picks that attachment when several share the name."),
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
		Description: "Adds and removes tags (by key or label) on messages. Returns {done: ids changed, failed: [{id, code}]}.",
		Input: schema([]string{"ids"}, m{
			"account": account(), "ids": strs("Message ids."), "add": strs("Tags to add."), "remove": strs("Tags to remove."),
		})},
	{Name: "mail_move", Group: "organise",
		Description: "Moves or copies messages to another folder of the same account; refuses other accounts, excluded folders, Trash, Junk and the Outbox (use mail_trash to bin mail). Returns {done: ids changed, failed: [{id, code}]}.",
		Input: schema([]string{"ids", "folder"}, m{
			"account": account(), "ids": strs("Message ids."), "folder": str("Target folder path."),
			"copy": boolean("Copy instead of move."),
		})},
	{Name: "mail_archive", Group: "organise",
		Description: "Archives messages; Thunderbird picks the destination under the account's archive folder. Returns {done, failed: [{id, code}]}.",
		Input:       schema([]string{"ids"}, m{"account": account(), "ids": strs("Message ids.")})},
	{Name: "mail_trash", Group: "organise", Destructive: true,
		Description: "Moves messages to the account's Trash folder. Returns {done: ids changed, failed: [{id, code}]}.",
		Input:       schema([]string{"ids"}, m{"account": account(), "ids": strs("Message ids.")})},
	{Name: "mail_draft", Group: "compose",
		Description: "Saves a new message, reply or forward to Drafts without sending; replies and forwards are saved to Drafts with threading kept. An account without a Drafts folder of its own saves to the Drafts folder of Local Folders when that is enabled. A forward is refused when the original has an attachment that is only a placeholder in the message (a FileLink, or a linked, detached or deleted file); forward_as attachment forwards such a message whole. Returns draftId, the saved draft's message id; draftId may be null when Thunderbird has not yet shown the saved draft in Drafts (the draft is still saved; do not save it again).",
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
