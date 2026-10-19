/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The rule for an address mail_send may send to (rulings R27, R28), shared
// by the send handler and the options page's allowlist check.

// PLAIN is an addr-spec with a simple local part (letters, digits and
// . _ + -, dots only between other characters) and a domain of
// letter-digit-hyphen labels (punycode, never Unicode). Anything else
// fails closed. Thunderbird's parser keeps a quoted local part such as
// "a@evil.com,b"@allowed.com as one address, but sendMessage splits
// recipient strings at that comma (ruling R27); and an RFC 2047 encoded
// word such as =?utf-8?q?x=40evil=2Ecom?=@allowed.com is plain atext, but
// MessageSend decodes it into the envelope recipient (ruling R28).
const ATOM = "[A-Za-z0-9_+-]+";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const PLAIN = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})*$`);

export const isPlainAddress = (address) => typeof address === "string" && address.length <= 254 && PLAIN.test(address);

// isPlainDomain says whether text is a domain of letter-digit-hyphen labels
// (punycode for international names), as used in an allowlist entry.
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
export const isPlainDomain = (domain) => typeof domain === "string" && domain.length <= 253 && DOMAIN.test(domain);
