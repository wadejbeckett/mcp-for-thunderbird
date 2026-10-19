#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""THROWAWAY spike (Task 2): seed synthetic messages into GreenMail by IMAP
APPEND (127.0.0.1:3143 only).

usage: seed.py big <user> <count> [threads] [first]  # bulk folder for search timing
       seed.py thread <user>                  # small thread for the reply test
Every 200th bulk message contains "zebra" (subject, body or author, in turn).
"""
import imaplib, random, sys, threading, time
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone

WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike "
         "november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee "
         "invoice meeting report budget server backup domain hosting renewal ticket").split()
BASE = datetime(2024, 1, 1, tzinfo=timezone.utc)

def bulk_msg(i, user):
    rnd = random.Random(i)
    body = "\r\n".join(" ".join(rnd.choice(WORDS) for _ in range(12)) for _ in range(rnd.randint(5, 25)))
    subj = " ".join(rnd.choice(WORDS) for _ in range(5)) + f" #{i}"
    author = f"Sender {i % 997} <sender{i % 997}@example.test>"
    if i % 200 == 0:
        k = (i // 200) % 3
        if k == 0: subj += " zebra"
        elif k == 1: body += "\r\nthe zebra crossed here"
        else: author = f"Zebra Person <zebra{i}@example.test>"
    d = BASE + timedelta(minutes=7 * i)
    return (f"From: {author}\r\nTo: {user}@localhost\r\nSubject: {subj}\r\n"
            f"Date: {format_datetime(d)}\r\nMessage-ID: <bulk-{i}@seed.test>\r\n"
            f"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n").encode(), d

def append_range(user, lo, hi, done):
    m = imaplib.IMAP4("127.0.0.1", 3143)
    m.login(user, user)
    for i in range(lo, hi):
        raw, d = bulk_msg(i, user)
        m.append("INBOX", None, imaplib.Time2Internaldate(d), raw)
        done[0] += 1
    m.logout()

if __name__ != "__main__":
    pass
elif sys.argv[1] == "big":
    user, count = sys.argv[2], int(sys.argv[3])
    nthreads = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    first = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    done = [0]
    step = (count + nthreads - 1) // nthreads
    t0 = time.time()
    ts = [threading.Thread(target=append_range, args=(user, first + k * step, first + min(count, (k + 1) * step), done))
          for k in range(nthreads)]
    for t in ts: t.start()
    while any(t.is_alive() for t in ts):
        time.sleep(15)
        el = time.time() - t0
        print(f"{done[0]} appended in {el:.0f}s ({done[0]/el:.0f}/s)", flush=True)
    print(f"DONE {done[0]} in {time.time()-t0:.1f}s", flush=True)
elif sys.argv[1] == "thread":
    user = sys.argv[2]
    m = imaplib.IMAP4("127.0.0.1", 3143)
    m.login(user, user)
    d1 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
    root = (f"From: Alice Example <alice@example.test>\r\nTo: Spike {user} <{user}@localhost>\r\n"
            f"Subject: Quarterly hosting review\r\nDate: {format_datetime(d1)}\r\n"
            f"Message-ID: <root-1@seed.test>\r\nMIME-Version: 1.0\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n\r\n"
            f"Hi,\r\n\r\nCan we move the review to Thursday?\r\nThe second line of the original.\r\n\r\nAlice\r\n").encode()
    d2 = d1 + timedelta(hours=2)
    child = (f"From: Bob Example <bob@example.test>\r\nTo: Spike {user} <{user}@localhost>\r\n"
             f"Cc: Alice Example <alice@example.test>\r\n"
             f"Subject: Re: Quarterly hosting review\r\nDate: {format_datetime(d2)}\r\n"
             f"Message-ID: <child-2@seed.test>\r\nIn-Reply-To: <root-1@seed.test>\r\n"
             f"References: <root-1@seed.test>\r\nMIME-Version: 1.0\r\n"
             f"Content-Type: text/html; charset=utf-8\r\n\r\n"
             f"<html><body><p>Thursday works for me.</p><p>Bob</p></body></html>\r\n").encode()
    for raw, d in ((root, d1), (child, d2)):
        print(m.append("INBOX", None, imaplib.Time2Internaldate(d), raw))
    m.logout()
