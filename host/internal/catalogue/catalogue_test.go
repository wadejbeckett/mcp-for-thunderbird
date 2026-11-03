// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package catalogue_test

import (
	"strings"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/catalogue"
)

var wantGroups = map[string]string{
	"mail_accounts": "read", "mail_folders": "read", "mail_search": "read", "mail_read": "read",
	"mail_thread": "read", "mail_attachment": "read", "mail_filter_suggest": "read",
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
	if len(all) != 16 {
		t.Fatalf("want 16 tools, got %d", len(all))
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
		if tl.Name == "mail_accounts" {
			if has {
				t.Error("mail_accounts must not take account")
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
		if d := byName(t, n).Description; !strings.Contains(d, "{done: ids changed, failed: [{id, code}]}") {
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
		for _, want := range []string{"address or id", "default identity"} {
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
		for _, want := range []string{"addressed to", "for mail you sent, from the identity that sent it", "any enabled account"} {
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
