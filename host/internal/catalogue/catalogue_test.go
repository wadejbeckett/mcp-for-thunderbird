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
