// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

package catalogue_test

import (
	"strings"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/catalogue"
)

var wantGroups = map[string]string{
	"mail_accounts": "read", "mail_folders": "read", "mail_search": "read", "mail_read": "read",
	"mail_thread": "read", "mail_attachment": "read", "mail_filter_suggest": "read", "mail_tags": "read",
	"mail_contacts": "contacts",
	"mail_mark":     "organise", "mail_tag": "organise", "mail_move": "organise", "mail_archive": "organise", "mail_trash": "organise",
	"mail_draft": "compose", "mail_compose": "compose",
	"mail_send": "send",
}

func byName(t *testing.T, name string) catalogue.Tool {
	t.Helper()
	for _, tl := range catalogue.All() {
		if tl.Name == name {
			return tl
		}
	}
	t.Fatalf("tool %s missing", name)
	return catalogue.Tool{}
}

func TestNamesAndGroups(t *testing.T) {
	all := catalogue.All()
	if len(all) != 17 {
		t.Fatalf("want 17 tools, got %d", len(all))
	}
	for _, tl := range all {
		g, ok := wantGroups[tl.Name]
		if !ok {
			t.Errorf("unexpected tool %s", tl.Name)
			continue
		}
		if tl.Group != g {
			t.Errorf("%s group = %s, want %s", tl.Name, tl.Group, g)
		}
		if tl.Description == "" || tl.Input == nil {
			t.Errorf("%s lacks description or schema", tl.Name)
		}
	}
}

func TestAnnotations(t *testing.T) {
	for _, tl := range catalogue.All() {
		// mail_attachment writes a file to the attachment folder (R14).
		if (tl.Group == "read" || tl.Group == "contacts") && tl.Name != "mail_attachment" {
			if !tl.ReadOnly {
				t.Errorf("%s should be ReadOnly", tl.Name)
			}
		} else if tl.ReadOnly {
			t.Errorf("%s should not be ReadOnly", tl.Name)
		}
		want := tl.Name == "mail_trash" || tl.Name == "mail_send"
		if tl.Destructive != want {
			t.Errorf("%s Destructive = %v, want %v", tl.Name, tl.Destructive, want)
		}
	}
	if a := byName(t, "mail_attachment"); a.ReadOnly || a.Idempotent || a.Destructive {
		t.Errorf("mail_attachment ReadOnly/Idempotent/Destructive = %v/%v/%v, want false/false/false",
			a.ReadOnly, a.Idempotent, a.Destructive)
	}
	if byName(t, "mail_move").Destructive {
		t.Error("mail_move must not be destructive")
	}
}

func TestFilterDropsUnknown(t *testing.T) {
	got := catalogue.Filter([]string{"mail_read", "nope", "mail_send", "mail_read"})
	if len(got) != 2 {
		t.Fatalf("got %d tools", len(got))
	}
	if got[0].Name != "mail_read" || got[1].Name != "mail_send" {
		t.Errorf("unexpected %v %v", got[0].Name, got[1].Name)
	}
	if len(catalogue.Filter(nil)) != 0 {
		t.Error("nil filter should give nothing")
	}
}

func TestSearchSchemaHasNoBodyOutput(t *testing.T) {
	d := byName(t, "mail_search").Description
	for _, s := range []string{"never returns message text", "case-sensitive", "newest first", "truncated"} {
		if !strings.Contains(d, s) {
			t.Errorf("mail_search description lacks %q: %s", s, d)
		}
	}
	if !strings.Contains(d, "hasAttachments") || !strings.Contains(d, "null") {
		t.Errorf("mail_search description must say hasAttachments may be null: %s", d)
	}
	td := byName(t, "mail_thread").Description
	if !strings.Contains(td, "pointers") || strings.Contains(td, "excerpt") {
		t.Errorf("mail_thread description must say it returns pointers only: %s", td)
	}
	if !strings.Contains(byName(t, "mail_send").Description, "allowed list") {
		t.Error("mail_send description must mention the allowed list")
	}
	if !strings.Contains(byName(t, "mail_draft").Description, "Drafts") {
		t.Error("mail_draft description must mention Drafts")
	}
	if !strings.Contains(byName(t, "mail_read").Description, "plainTextDiffers") {
		t.Error("mail_read description must explain plainTextDiffers")
	}
	if d := byName(t, "mail_draft").Description; !strings.Contains(d, "Returns draftId") || strings.Contains(d, "null") {
		t.Errorf("mail_draft description must say it returns draftId, which is never null: %s", d)
	}
	if !strings.Contains(byName(t, "mail_send").Description, "only simple addresses (letters, digits, . _ + -)") {
		t.Error("mail_send description must say only simple addresses can be sent to")
	}
}

func props(t *testing.T, name string) map[string]map[string]any {
	t.Helper()
	p, ok := byName(t, name).Input["properties"].(map[string]any)
	if !ok {
		t.Fatalf("%s has no properties", name)
	}
	out := map[string]map[string]any{}
	for k, v := range p {
		out[k] = v.(map[string]any)
	}
	return out
}

func TestAttachmentPart(t *testing.T) {
	part, ok := props(t, "mail_attachment")["part"]
	if !ok || part["type"] != "string" || part["description"] == "" {
		t.Fatalf("mail_attachment must take an optional part string with a description: %v", part)
	}
	for _, r := range byName(t, "mail_attachment").Input["required"].([]string) {
		if r == "part" {
			t.Error("part must be optional")
		}
	}
	if !strings.Contains(byName(t, "mail_read").Description, "part") {
		t.Error("mail_read description must mention each attachment's part")
	}
}

// TestReadFoldersAccountsDescriptions checks that the tools describe the
// fields they return: identities and the default account, folder counts
// and quota, attachment types, and every header on request.
func TestReadFoldersAccountsDescriptions(t *testing.T) {
	for _, w := range []string{"identities", "default"} {
		if !strings.Contains(byName(t, "mail_accounts").Description, w) {
			t.Errorf("mail_accounts description must mention %q", w)
		}
	}
	for _, w := range []string{"new", "quota", "lastUsed", "favorite", "null", "note"} {
		if !strings.Contains(byName(t, "mail_folders").Description, w) {
			t.Errorf("mail_folders description must mention %q", w)
		}
	}
	// lastUsed is Thunderbird's MRUTime, not only when the user opened the folder
	f := byName(t, "mail_folders").Description
	for _, w := range []string{"moved", "delivered", "could not read", "in time"} {
		if !strings.Contains(f, w) {
			t.Errorf("mail_folders description must mention %q", w)
		}
	}
	if strings.Contains(f, "when the user last opened it") {
		t.Error("mail_folders description must not say lastUsed is only when the user opened the folder")
	}
	r := byName(t, "mail_read").Description
	for _, w := range []string{"normal", "linked", "cloudFile", "detached", "deleted", "link", "attachmentsTruncated", "allHeaders", "Bcc", "Resent-Bcc", "-bcc"} {
		if !strings.Contains(r, w) {
			t.Errorf("mail_read description must mention %q", w)
		}
	}
	h, ok := props(t, "mail_read")["headers"]
	if !ok || h["type"] != "boolean" || h["description"] == "" {
		t.Errorf("mail_read must take an optional headers boolean: %v", h)
	}
	if req := byName(t, "mail_attachment").Input["required"].([]string); len(req) != 1 || req[0] != "id" {
		t.Errorf("mail_attachment must require only id, so a part alone fetches a nameless attachment: %v", req)
	}
	if !strings.Contains(byName(t, "mail_attachment").Description, "placeholder") {
		t.Error("mail_attachment description must say attachments not in the message are refused")
	}
}

func TestLimits(t *testing.T) {
	if m := props(t, "mail_search")["limit"]["maximum"]; m != 200 {
		t.Errorf("limit maximum = %v", m)
	}
	if m := props(t, "mail_search")["limit"]["default"]; m != 25 {
		t.Errorf("limit default = %v", m)
	}
	if m := props(t, "mail_contacts")["limit"]["maximum"]; m != 200 {
		t.Errorf("contacts limit maximum = %v", m)
	}
	if m := props(t, "mail_contacts")["limit"]["default"]; m != 25 {
		t.Errorf("contacts limit default = %v", m)
	}
	if m := props(t, "mail_read")["max_chars"]["maximum"]; m != 50000 {
		t.Errorf("max_chars maximum = %v", m)
	}
	if m := props(t, "mail_read")["max_chars"]["default"]; m != 8000 {
		t.Errorf("max_chars default = %v", m)
	}
}

func TestAccountAndIdArguments(t *testing.T) {
	for _, tl := range catalogue.All() {
		_, has := props(t, tl.Name)["account"]
		// Accounts, tags and address books belong to the whole profile.
		if tl.Name == "mail_accounts" || tl.Name == "mail_tags" || tl.Name == "mail_contacts" {
			if has {
				t.Errorf("%s must not take account", tl.Name)
			}
			continue
		}
		if !has {
			t.Errorf("%s lacks account", tl.Name)
		}
	}
	for _, n := range []string{"mail_read", "mail_thread", "mail_attachment"} {
		if _, ok := props(t, n)["id"]; !ok {
			t.Errorf("%s lacks id", n)
		}
	}
	for _, n := range []string{"mail_mark", "mail_tag", "mail_move", "mail_archive", "mail_trash"} {
		if _, ok := props(t, n)["ids"]; !ok {
			t.Errorf("%s lacks ids", n)
		}
	}
}

func TestContactsArguments(t *testing.T) {
	p := props(t, "mail_contacts")
	if p["book"]["type"] != "string" {
		t.Errorf("mail_contacts book = %v", p["book"])
	}
	if p["include_lists"]["type"] != "boolean" {
		t.Errorf("mail_contacts include_lists = %v", p["include_lists"])
	}
	req := byName(t, "mail_contacts").Input["required"].([]string)
	if len(req) != 1 || req[0] != "query" {
		t.Errorf("mail_contacts required = %v, want [query]", req)
	}
	d := byName(t, "mail_contacts").Description
	for _, w := range []string{"truncated", "include_lists", "whole Thunderbird profile", "returned once", "sharing an address"} {
		if !strings.Contains(d, w) {
			t.Errorf("mail_contacts description lacks %q", w)
		}
	}
}

func TestAttachmentsMaxItems(t *testing.T) {
	for _, n := range []string{"mail_draft", "mail_compose", "mail_send"} {
		props := byName(t, n).Input["properties"].(map[string]any)
		a := props["attachments"].(map[string]any)
		if a["maxItems"] != 20 {
			t.Errorf("%s attachments maxItems = %v, want 20", n, a["maxItems"])
		}
	}
}

func TestAttachmentAndFilterSuggestDescriptions(t *testing.T) {
	a := byName(t, "mail_attachment").Description
	if !strings.Contains(a, "inline") || strings.Contains(a, "for text types, extracted text") {
		t.Errorf("mail_attachment description must say text types are returned inline, not saved: %q", a)
	}
	f := byName(t, "mail_filter_suggest").Description
	if !strings.Contains(f, "step-by-step instructions") {
		t.Errorf("mail_filter_suggest description must say it returns step-by-step instructions: %q", f)
	}
	acts := props(t, "mail_filter_suggest")["actions"]
	if acts["minItems"] != 1 {
		t.Errorf("mail_filter_suggest actions minItems = %v, want 1", acts["minItems"])
	}
}

func TestSearchBodyOfflineAndMoveTrashResults(t *testing.T) {
	if d := byName(t, "mail_search").Description; !strings.Contains(d, "stored offline") {
		t.Errorf("mail_search must say body text is found only in mail stored offline: %s", d)
	}
	for _, n := range []string{"mail_move", "mail_trash"} {
		if d := byName(t, n).Description; !strings.Contains(d, "{done: ids changed, failed: [{id, code}]") {
			t.Errorf("%s must describe its {done, failed} result: %s", n, d)
		}
	}
	if d := byName(t, "mail_move").Description; !strings.Contains(d, "Outbox") {
		t.Errorf("mail_move must say it refuses the Outbox: %s", d)
	}
}

func TestBodyDescribesLists(t *testing.T) {
	for _, n := range []string{"mail_draft", "mail_compose", "mail_send"} {
		d, _ := props(t, n)["body"]["description"].(string)
		for _, want := range []string{`"- "`, `"* "`, `"1. "`, "indented line", "blank line"} {
			if !strings.Contains(d, want) {
				t.Errorf("%s body description must mention %s", n, want)
			}
		}
	}
}

func TestHTMLBodyOption(t *testing.T) {
	for _, n := range []string{"mail_draft", "mail_compose", "mail_send"} {
		h := props(t, n)["html"]
		if h["type"] != "boolean" {
			t.Fatalf("%s html type = %v, want boolean", n, h["type"])
		}
		d, _ := h["description"].(string)
		for _, want := range []string{"table", "ul", "strong", "href", "signature"} {
			if !strings.Contains(d, want) {
				t.Errorf("%s html description must mention %s", n, want)
			}
		}
	}
}

func TestComposeIdentityKindsAndForward(t *testing.T) {
	for _, n := range []string{"mail_draft", "mail_compose", "mail_send"} {
		f, ok := props(t, n)["from"]
		if !ok || f["type"] != "string" {
			t.Fatalf("%s must take a from string: %v", n, f)
		}
		d, _ := f["description"].(string)
		for _, want := range []string{"address or id", "default identity", "mail_accounts"} {
			if !strings.Contains(d, want) {
				t.Errorf("%s from description must mention %q: %s", n, want, d)
			}
		}
		for _, r := range byName(t, n).Input["required"].([]string) {
			if r == "from" {
				t.Errorf("%s: from must be optional", n)
			}
		}
	}
	for _, n := range []string{"mail_draft", "mail_compose"} {
		d, _ := props(t, n)["from"]["description"].(string)
		for _, want := range []string{"addressed to", "for mail you sent, from the identity that sent it", "any enabled account", "With account, a reply or forward is written from that account, which need not be the original's"} {
			if !strings.Contains(d, want) {
				t.Errorf("%s from description must mention %q: %s", n, want, d)
			}
		}
	}
	for _, n := range []string{"mail_draft", "mail_compose"} {
		kind := props(t, n)["kind"]
		if got := strings.Join(kind["enum"].([]string), ","); got != "new,reply,reply_all,reply_list,forward" {
			t.Errorf("%s kind enum = %s", n, got)
		}
		if d, _ := kind["description"].(string); !strings.Contains(d, "List-Post") {
			t.Errorf("%s kind description must explain reply_list: %s", n, d)
		}
		fa := props(t, n)["forward_as"]
		if got := strings.Join(fa["enum"].([]string), ","); got != "inline,attachment" {
			t.Errorf("%s forward_as enum = %s", n, got)
		}
	}
	if _, ok := props(t, "mail_send")["forward_as"]; ok {
		t.Error("mail_send sends new messages only and must not take forward_as")
	}
	if d := byName(t, "mail_compose").Description; !strings.Contains(d, "tabId") || !strings.Contains(d, "windowId") {
		t.Errorf("mail_compose description must name the tabId and windowId it returns: %s", d)
	}
	if d := byName(t, "mail_send").Description; !strings.Contains(d, "offline") {
		t.Errorf("mail_send description must say nothing is sent while offline: %s", d)
	}
	if d := byName(t, "mail_draft").Description; !strings.Contains(d, "Local Folders") || !strings.Contains(d, "placeholder") || !strings.Contains(d, "never saved in another server account") {
		t.Errorf("mail_draft description must mention Local Folders' Drafts, that no other server account gets a draft, and placeholder attachments: %s", d)
	}
}

func TestSearchArgumentsFromCoverageAudit(t *testing.T) {
	p := props(t, "mail_search")
	for _, k := range []string{"junk", "to_me", "from_me", "subfolders"} {
		if p[k]["type"] != "boolean" || p[k]["description"] == "" {
			t.Errorf("mail_search %s must be a described boolean: %v", k, p[k])
		}
	}
	if p["tags"]["type"] != "array" {
		t.Errorf("mail_search tags must be a list: %v", p["tags"])
	}
	modes, _ := p["tags_mode"]["enum"].([]string)
	if strings.Join(modes, ",") != "all,any,none,untagged" {
		t.Errorf("mail_search tags_mode enum = %v", modes)
	}
	for _, k := range []string{"from", "to"} {
		d, _ := p[k]["description"].(string)
		if strings.Contains(d, "contains.") || !strings.Contains(d, "whole address") {
			t.Errorf("mail_search %s must say how a whole address and other text match: %s", k, d)
		}
	}
	for _, k := range []string{"to_me", "from_me"} {
		if d, _ := p[k]["description"].(string); !strings.Contains(d, "enabled accounts' addresses") {
			t.Errorf("mail_search %s must say it compares with the enabled accounts' addresses: %s", k, d)
		}
	}
	if d, _ := p["tags_mode"]["description"].(string); !strings.Contains(d, "message by message") {
		t.Errorf("mail_search tags_mode must say untagged is checked message by message: %s", d)
	}
	d := byName(t, "mail_search").Description
	for _, s := range []string{"note on how to narrow", "priority", "before 148", "tags_mode untagged", "to_me or from_me false"} {
		if !strings.Contains(d, s) {
			t.Errorf("mail_search description lacks %q: %s", s, d)
		}
	}
	if u, _ := p["until"]["description"].(string); !strings.Contains(u, "future") {
		t.Errorf("mail_search until must say mail dated in the future is found without it: %s", u)
	}
	td := byName(t, "mail_thread").Description
	for _, s := range []string{"truncated", "200", "100", "newest 200 later messages", "priority"} {
		if !strings.Contains(td, s) {
			t.Errorf("mail_thread description lacks %q: %s", s, td)
		}
	}
}

func TestOrganiseDescriptions(t *testing.T) {
	for _, n := range []string{"mail_move", "mail_archive", "mail_trash"} {
		if d := byName(t, n).Description; !strings.Contains(d, "moved: [{from, to}]") {
			t.Errorf("%s description must name the new ids it returns: %s", n, d)
		}
	}
	mv := byName(t, "mail_move").Description
	for _, s := range []string{"copied", "own folder", "cannot hold messages"} {
		if !strings.Contains(mv, s) {
			t.Errorf("mail_move description lacks %q: %s", s, mv)
		}
	}
	ar := byName(t, "mail_archive").Description
	for _, s := range []string{"not_enabled", "not enabled or is excluded", "already in its archive folder", "copied: [{from, to}]", "refused and mayHaveCompleted", "a year or month folder Thunderbird makes for the archive is such a folder until the user checks the excluded folders"} {
		if !strings.Contains(ar, s) {
			t.Errorf("mail_archive description lacks %q: %s", s, ar)
		}
	}
}

func TestTagsTool(t *testing.T) {
	tl := byName(t, "mail_tags")
	if !tl.ReadOnly || !tl.Idempotent || tl.Destructive {
		t.Errorf("mail_tags ReadOnly/Idempotent/Destructive = %v/%v/%v", tl.ReadOnly, tl.Idempotent, tl.Destructive)
	}
	if len(props(t, "mail_tags")) != 0 || tl.Input["additionalProperties"] != false {
		t.Errorf("mail_tags must take no arguments: %v", tl.Input)
	}
	for _, s := range []string{"key", "label", "color", "no account is enabled"} {
		if !strings.Contains(tl.Description, s) {
			t.Errorf("mail_tags description lacks %q", s)
		}
	}
	if !strings.Contains(byName(t, "mail_tag").Description, "mail_tags") {
		t.Error("mail_tag description must point to mail_tags")
	}
	for _, k := range []string{"tag", "tags"} {
		if d, _ := props(t, "mail_search")[k]["description"].(string); !strings.Contains(d, "mail_tags") {
			t.Errorf("mail_search %s must point to mail_tags: %s", k, d)
		}
	}
}

// TestFoldersDescribesNewFolders: a new folder in an account with
// excluded folders is hidden until the user checks the excluded folders
// (addon/src/exclusions.js), and the description says so.
func TestFoldersDescribesNewFolders(t *testing.T) {
	d := byName(t, "mail_folders").Description
	for _, want := range []string{"leaving out folders the user has excluded", "has appeared since the user last checked", "until the user checks them again"} {
		if !strings.Contains(d, want) {
			t.Errorf("mail_folders description lacks %q: %s", want, d)
		}
	}
}
