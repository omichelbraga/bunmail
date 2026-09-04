import { describe, test, expect } from "bun:test";
import {
  prepareRawForRelay,
  formatRfc5322Date,
} from "../../src/modules/smtp-submission/message-mapper.ts";

/**
 * `prepareRawForRelay` is the only transformation applied to a mailbox
 * user's message before it is relayed byte-for-byte: drop `Bcc:` and make
 * sure a `Message-ID` exists. Everything else must survive untouched.
 */

const FALLBACK = "<fallback@mail.example.com>";
const NOW = new Date("2026-09-04T08:22:54Z");
const DATE_LINE = "Date: Fri, 04 Sep 2026 08:22:54 +0000\r\n";

describe("prepareRawForRelay", () => {
  test("keeps the client's Message-ID and headers verbatim", () => {
    const raw =
      "From: mike@example.com\r\n" +
      "To: sam@example.org\r\n" +
      "Message-ID: <abc@client>\r\n" +
      "In-Reply-To: <orig@example.org>\r\n" +
      "References: <orig@example.org>\r\n" +
      "Subject: Re: hi\r\n" +
      "\r\n" +
      "body\r\n";
    const out = prepareRawForRelay(raw, FALLBACK, NOW);
    expect(out.messageId).toBe("<abc@client>");
    expect(out.raw).toBe(raw.replace("\r\n\r\n", `\r\n${DATE_LINE}\r\n`));
  });

  test("leaves a client-provided Date alone", () => {
    const raw =
      "From: mike@example.com\r\nDate: Thu, 03 Sep 2026 10:00:00 -0300\r\nMessage-ID: <abc@client>\r\n\r\nbody\r\n";
    expect(prepareRawForRelay(raw, FALLBACK, NOW).raw).toBe(raw);
  });

  test("formats RFC 5322 dates in UTC with a numeric zone", () => {
    expect(formatRfc5322Date(NOW)).toBe("Fri, 04 Sep 2026 08:22:54 +0000");
  });

  test("inserts the fallback Message-ID when the client omitted it", () => {
    const raw = "From: mike@example.com\r\nTo: sam@example.org\r\n\r\nbody\r\n";
    const out = prepareRawForRelay(raw, FALLBACK, NOW);
    expect(out.messageId).toBe(FALLBACK);
    expect(out.raw).toBe(
      `From: mike@example.com\r\nTo: sam@example.org\r\nMessage-ID: ${FALLBACK}\r\n${DATE_LINE}\r\nbody\r\n`,
    );
  });

  test("drops a Bcc header, including folded continuation lines", () => {
    const raw =
      "From: mike@example.com\r\n" +
      "Bcc: hidden@example.net,\r\n" +
      "\tother-hidden@example.net\r\n" +
      "To: sam@example.org\r\n" +
      "Message-ID: <abc@client>\r\n" +
      "\r\n" +
      "body\r\n";
    const out = prepareRawForRelay(raw, FALLBACK, NOW);
    expect(out.raw).not.toContain("hidden@example.net");
    expect(out.raw).toContain("To: sam@example.org\r\n");
    expect(out.raw).toContain("\r\n\r\nbody\r\n");
  });

  test("does not touch the body even if it contains header-like lines", () => {
    const raw =
      "From: mike@example.com\r\nMessage-ID: <abc@client>\r\n\r\nBcc: not-a-header\r\nMessage-ID: <also-not@body>\r\n";
    const out = prepareRawForRelay(raw, FALLBACK, NOW);
    expect(out.raw).toContain("Bcc: not-a-header");
    expect(out.messageId).toBe("<abc@client>");
  });

  test("handles a message with headers only", () => {
    const out = prepareRawForRelay("From: mike@example.com", FALLBACK, NOW);
    expect(out.raw).toBe(
      `From: mike@example.com\r\nMessage-ID: ${FALLBACK}\r\n${DATE_LINE}\r\n`,
    );
  });
});
