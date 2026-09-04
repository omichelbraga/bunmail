import { describe, test, expect } from "bun:test";
import { prepareRawForRelay } from "../../src/modules/smtp-submission/message-mapper.ts";

/**
 * `prepareRawForRelay` is the only transformation applied to a mailbox
 * user's message before it is relayed byte-for-byte: drop `Bcc:` and make
 * sure a `Message-ID` exists. Everything else must survive untouched.
 */

const FALLBACK = "<fallback@mail.example.com>";

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
    const out = prepareRawForRelay(raw, FALLBACK);
    expect(out.messageId).toBe("<abc@client>");
    expect(out.raw).toBe(raw);
  });

  test("inserts the fallback Message-ID when the client omitted it", () => {
    const raw = "From: mike@example.com\r\nTo: sam@example.org\r\n\r\nbody\r\n";
    const out = prepareRawForRelay(raw, FALLBACK);
    expect(out.messageId).toBe(FALLBACK);
    expect(out.raw).toBe(
      `From: mike@example.com\r\nTo: sam@example.org\r\nMessage-ID: ${FALLBACK}\r\n\r\nbody\r\n`,
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
    const out = prepareRawForRelay(raw, FALLBACK);
    expect(out.raw).not.toContain("hidden@example.net");
    expect(out.raw).toContain("To: sam@example.org\r\n");
    expect(out.raw).toContain("\r\n\r\nbody\r\n");
  });

  test("does not touch the body even if it contains header-like lines", () => {
    const raw =
      "From: mike@example.com\r\nMessage-ID: <abc@client>\r\n\r\nBcc: not-a-header\r\nMessage-ID: <also-not@body>\r\n";
    const out = prepareRawForRelay(raw, FALLBACK);
    expect(out.raw).toContain("Bcc: not-a-header");
    expect(out.messageId).toBe("<abc@client>");
  });

  test("handles a message with headers only", () => {
    const out = prepareRawForRelay("From: mike@example.com", FALLBACK);
    expect(out.raw).toBe(`From: mike@example.com\r\nMessage-ID: ${FALLBACK}\r\n\r\n`);
  });
});
