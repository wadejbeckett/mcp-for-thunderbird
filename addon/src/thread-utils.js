/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for thread reconstruction, and the concurrency limiter.
// Derived from the vitalio-sh "thunderbird-cli" extension
// (extension/src/thread-utils.js and mapWithIpcLimit in
// extension/src/background.js, seed commit 465613d), MIT licence, see
// NOTICE. Changed to ES module exports; the limiter takes its size.

// parseHeader reads a named header from an RFC 5322 message head. Only the
// header block is scanned, and folded headers are unfolded first.
export function parseHeader(raw, name) {
  const end = raw.search(/\r?\n\r?\n/);
  const headerSection = end === -1 ? raw : raw.slice(0, end);
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(new RegExp(`^${name}:[ \\t]*(.+)`, "im"));
  return m ? m[1].trim() : "";
}

// stripAngleBrackets: <id@host> -> id@host
export function stripAngleBrackets(s) {
  return String(s).trim().replace(/^<|>$/g, "").trim();
}

// parseReferences extracts every <id> token from a References or
// In-Reply-To value, without brackets.
export function parseReferences(headerValue) {
  return (String(headerValue).match(/<[^>]+>/g) || []).map(stripAngleBrackets);
}

// normalizeSubject strips leading reply/forward prefixes (English and
// common European forms) and [list-name] tags.
export function normalizeSubject(subject) {
  return String(subject)
    .trim()
    .replace(/^((Re|WG|AW|Fwd?|FW|Sv|Vs|Ref):\s*|\[[^\]]*\]\s*)*/gi, "")
    .trim();
}

// buildThreadIds returns the Message-IDs (without brackets) that identify
// a message's upstream thread: its own Message-ID plus References and
// In-Reply-To.
export function buildThreadIds(raw) {
  const refs = parseReferences(parseHeader(raw, "References"));
  const inReplyTo = parseReferences(parseHeader(raw, "In-Reply-To"));
  const msgHdrId = stripAngleBrackets(parseHeader(raw, "Message-ID"));
  return new Set([...refs, ...inReplyTo, msgHdrId].filter(Boolean));
}

// createLimiter returns map(items, fn): fn over items, order kept, with at
// most `size` calls in flight across every caller of this limiter.
export function createLimiter(size) {
  const queue = [];
  let inFlight = 0;
  const drain = () => {
    while (inFlight < size && queue.length > 0) {
      const { run, resolve, reject } = queue.shift();
      inFlight++;
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          drain();
        });
    }
  };
  const one = (run) =>
    new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      drain();
    });
  return {
    run: one,
    map: (items, fn) => Promise.all(items.map((item) => one(() => fn(item)))),
  };
}
