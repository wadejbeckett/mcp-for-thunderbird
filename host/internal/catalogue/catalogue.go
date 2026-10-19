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

func account() m { return str("Account id or name; optional when only one account is enabled.") }

func schema(required []string, props m) m {
	s := m{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func composeProps() m {
	return m{
		"account":     account(),
		"kind":        enum("new, reply, reply_all or forward.", "new", "reply", "reply_all", "forward"),
		"id":          str("Message id to reply to or forward."),
		"to":          strs("To recipients."),
		"cc":          strs("Cc recipients."),
		"bcc":         strs("Bcc recipients."),
		"subject":     str("Subject; defaults to the original's for replies and forwards."),
		"body":        str("Plain-text body."),
		"attachments": strs("File names in the attachment folder."),
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
		Description: "Finds messages and returns headers only (id, from, subject, date, flags, tags) and never returns message text; use mail_read for text. Text matching is case-sensitive in Thunderbird, and results come newest first and may be truncated, with a note on how to narrow the search.",
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
		Description: "Returns one message's headers, plain-text body (wrapped as untrusted content) and attachment names.",
		Input: schema([]string{"id"}, m{
			"account": account(), "id": str("Message id from mail_search."),
			"max_chars": m{"type": "integer", "minimum": 1, "maximum": 50000, "default": 8000, "description": "Maximum body characters."},
		})},
	{Name: "mail_thread", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Returns the messages in the conversation of one message, headers and short excerpts only.",
		Input:       schema([]string{"id"}, m{"account": account(), "id": str("Message id from mail_search.")})},
	{Name: "mail_attachment", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Saves one attachment to the user's attachment folder and returns its path and, for text types, extracted text.",
		Input: schema([]string{"id", "name"}, m{
			"account": account(), "id": str("Message id."), "name": str("Attachment file name."),
		})},
	{Name: "mail_filter_suggest", Group: "read", ReadOnly: true, Idempotent: true,
		Description: "Turns conditions and actions into a Thunderbird message-filter rule the user can paste in; it changes nothing.",
		Input: schema([]string{"account"}, m{
			"account": account(),
			"conditions": m{"type": "array", "items": schema([]string{"field", "op", "value"}, m{
				"field": enum("Field.", "from", "to", "subject", "body", "tag", "date"),
				"op":    enum("Operator.", "contains", "is", "begins", "ends", "before", "after"),
				"value": str("Value to compare."),
			})},
			"match": enum("all or any condition.", "all", "any"),
			"actions": m{"type": "array", "items": schema([]string{"type"}, m{
				"type":  enum("Action.", "move", "copy", "tag", "mark_read", "flag"),
				"value": str("Folder path or tag, where the action needs one."),
			})},
		})},
	{Name: "mail_contacts", Group: "contacts", ReadOnly: true, Idempotent: true,
		Description: "Searches the user's address books and returns names and email addresses.",
		Input: schema([]string{"query"}, m{
			"account": account(), "query": str("Name or address fragment."),
			"limit": m{"type": "integer", "minimum": 1, "maximum": 100, "default": 20, "description": "Maximum results."},
		})},
	{Name: "mail_mark", Group: "organise", Idempotent: true,
		Description: "Sets read and flagged state on messages and returns how many changed.",
		Input: schema([]string{"ids"}, m{
			"account": account(), "ids": strs("Message ids."),
			"read": boolean("Mark read (true) or unread (false)."), "flagged": boolean("Flag (true) or unflag (false)."),
		})},
	{Name: "mail_tag", Group: "organise", Idempotent: true,
		Description: "Adds and removes tags on messages and returns how many changed.",
		Input: schema([]string{"ids"}, m{
			"account": account(), "ids": strs("Message ids."), "add": strs("Tags to add."), "remove": strs("Tags to remove."),
		})},
	{Name: "mail_move", Group: "organise",
		Description: "Moves or copies messages to another folder of the same account; refuses other accounts and excluded folders.",
		Input: schema([]string{"ids", "folder"}, m{
			"account": account(), "ids": strs("Message ids."), "folder": str("Target folder path."),
			"copy": boolean("Copy instead of move."),
		})},
	{Name: "mail_archive", Group: "organise",
		Description: "Moves messages to the account's archive folder.",
		Input:       schema([]string{"ids"}, m{"account": account(), "ids": strs("Message ids.")})},
	{Name: "mail_trash", Group: "organise", Destructive: true,
		Description: "Moves messages to the account's Trash folder.",
		Input:       schema([]string{"ids"}, m{"account": account(), "ids": strs("Message ids.")})},
	{Name: "mail_draft", Group: "compose",
		Description: "Saves a new message, reply or forward to Drafts without sending; replies and forwards are saved to Drafts with threading kept.",
		Input:       schema([]string{"kind", "body"}, composeProps())},
	{Name: "mail_compose", Group: "compose",
		Description: "Opens a compose window in Thunderbird, filled in, for the user to review and send.",
		Input:       schema([]string{"kind", "body"}, composeProps())},
	{Name: "mail_send", Group: "send", Destructive: true,
		Description: "Sends a new message directly, and only to recipients on the user's allowed list; any other recipient refuses the whole message.",
		Input: schema([]string{"to", "subject", "body"}, m{
			"account": account(), "to": strs("To recipients."), "cc": strs("Cc recipients."), "bcc": strs("Bcc recipients."),
			"subject": str("Subject."), "body": str("Plain-text body."), "attachments": strs("File names in the attachment folder."),
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
