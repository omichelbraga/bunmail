"""
BunMail — STARTTLS front for the inbound SMTP receiver (port 25).

Why this exists
---------------
BunMail's inbound receiver (smtp-server on Bun) cannot offer STARTTLS:
`smtp-server` upgrades sockets with `new tls.TLSSocket(socket)`, which Bun
does not implement (the handshake never completes). Receiving MTAs therefore
delivered to us in cleartext. This tiny proxy sits on the public port 25,
terminates STARTTLS with the Let's Encrypt cert from the `acme` sidecar, and
relays the session in cleartext to BunMail on the private Docker network.

BunMail stays the receiver: DNSBL, rate limiting, recipient validation,
LMTP hand-off, logs and webhooks are untouched. To keep the *real* client
IP for those, every backend connection starts with a HAProxy PROXY protocol
v1 line, which smtp-server understands (`useProxy: true`,
`SMTP_PROXY_PROTOCOL=true` in BunMail).

What it does per connection
---------------------------
1. Connect to the backend, send `PROXY TCP4 <client> <server> <cport> <sport>`.
2. Relay the 220 greeting.
3. On EHLO (before TLS): forward, then add `250-STARTTLS` to the backend's
   capability list on the way back.
4. On STARTTLS: reply 220 and upgrade the client side with
   `loop.start_tls(..., server_side=True)`. From then on the client speaks
   TLS to us and we keep speaking cleartext to the backend.
5. Everything else (including DATA payload) is relayed byte-for-byte.

Only a few lines are inspected; no mail is parsed or stored here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import ssl
import sys
import time

BACKEND_HOST = os.environ.get("BACKEND_HOST", "app")
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", "25"))
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "25"))
CERT_FILE = os.environ.get("CERT_FILE", "/certs/fullchain.pem")
KEY_FILE = os.environ.get("KEY_FILE", "/certs/privkey.pem")
PROXY_PROTOCOL = os.environ.get("PROXY_PROTOCOL", "true").lower() == "true"
IDLE_TIMEOUT = float(os.environ.get("IDLE_TIMEOUT", "300"))
MAX_LINE = 64 * 1024

log = logging.getLogger("smtp-tls")
logging.basicConfig(level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO), format="%(asctime)s smtp-tls %(levelname)s %(message)s", stream=sys.stdout)


class CertReloader:
    """Builds an SSLContext from the PEM pair and rebuilds it when the files change."""

    def __init__(self) -> None:
        self._ctx: ssl.SSLContext | None = None
        self._stamp: tuple[float, float] | None = None

    def context(self) -> ssl.SSLContext:
        try:
            stamp = (os.stat(CERT_FILE).st_mtime, os.stat(KEY_FILE).st_mtime)
        except FileNotFoundError:
            if self._ctx is None:
                raise
            return self._ctx
        if self._ctx is None or stamp != self._stamp:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(CERT_FILE, KEY_FILE)
            self._ctx, self._stamp = ctx, stamp
            log.info("TLS certificate (re)loaded from %s", CERT_FILE)
        return self._ctx


CERTS = CertReloader()


def proxy_line(client_peer: tuple, server_sock: tuple) -> bytes:
    """HAProxy PROXY protocol v1 header describing the original client."""
    cip, cport = client_peer[0], client_peer[1]
    sip, sport = server_sock[0], server_sock[1]
    fam = "TCP6" if ":" in cip else "TCP4"
    # Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) so the backend sees plain IPv4.
    if cip.startswith("::ffff:") and cip.count(".") == 3:
        cip, fam = cip[7:], "TCP4"
        if sip.startswith("::ffff:"):
            sip = sip[7:]
    return f"PROXY {fam} {cip} {sip} {cport} {sport}\r\n".encode()


async def relay_backend_to_client(backend_r: asyncio.StreamReader, state: dict) -> None:
    """Backend → client. Injects 250-STARTTLS into the EHLO reply while still in cleartext.

    Always writes through ``state["client_w"]``: that writer is replaced by
    the TLS one after STARTTLS, and writing to the old plaintext transport
    would inject cleartext into the TLS stream.
    """
    try:
        while True:
            line = await asyncio.wait_for(backend_r.readline(), IDLE_TIMEOUT)
            if not line:
                break
            client_w: asyncio.StreamWriter = state["client_w"]
            if state["expect_ehlo_reply"] and line[:4] in (b"250-", b"250 "):
                # Collect the whole multi-line EHLO response, then rewrite it.
                lines = [line]
                while lines[-1][:4] == b"250-":
                    nxt = await asyncio.wait_for(backend_r.readline(), IDLE_TIMEOUT)
                    if not nxt:
                        break
                    lines.append(nxt)
                state["expect_ehlo_reply"] = False
                if not state["tls"]:
                    # Turn the final "250 X" into "250-X" and append STARTTLS.
                    last = lines[-1]
                    if last[:4] == b"250 ":
                        lines[-1] = b"250-" + last[4:]
                    lines.append(b"250 STARTTLS\r\n")
                client_w.write(b"".join(lines))
            else:
                if state["expect_ehlo_reply"] and line[:1] != b"2":
                    state["expect_ehlo_reply"] = False
                client_w.write(line)
            await client_w.drain()
    except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        with_suppress_close(state["client_w"])


def with_suppress_close(w: asyncio.StreamWriter) -> None:
    try:
        w.close()
    except Exception:
        pass


async def handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    peer = client_w.get_extra_info("peername") or ("0.0.0.0", 0)
    sockname = client_w.get_extra_info("sockname") or ("0.0.0.0", LISTEN_PORT)
    started = time.monotonic()
    state = {"tls": False, "expect_ehlo_reply": False, "in_data": False, "client_w": client_w}
    try:
        backend_r, backend_w = await asyncio.wait_for(
            asyncio.open_connection(BACKEND_HOST, BACKEND_PORT), 15
        )
    except Exception as exc:  # backend down → temporary failure, sender retries
        log.warning("backend unreachable for %s: %s", peer[0], exc)
        client_w.write(b"421 4.3.2 Service temporarily unavailable, try again later\r\n")
        await client_w.drain()
        with_suppress_close(client_w)
        return

    if PROXY_PROTOCOL:
        backend_w.write(proxy_line(peer, sockname))
        await backend_w.drain()

    b2c = asyncio.create_task(relay_backend_to_client(backend_r, state))
    try:
        while True:
            line = await asyncio.wait_for(client_r.readline(), IDLE_TIMEOUT)
            if not line:
                log.debug("client EOF from %s (tls=%s, at_eof=%s)", peer[0], state["tls"], client_r.at_eof())
                break
            if len(line) > MAX_LINE:
                client_w.write(b"500 5.5.2 Line too long\r\n")
                await client_w.drain()
                break
            if state["in_data"]:
                backend_w.write(line)
                if line == b".\r\n":
                    state["in_data"] = False
                await backend_w.drain()
                continue
            cmd = line[:8].upper()
            if cmd.startswith(b"STARTTLS"):
                if state["tls"]:
                    client_w.write(b"503 5.5.1 TLS already active\r\n")
                    await client_w.drain()
                    continue
                try:
                    ctx = CERTS.context()
                except Exception as exc:
                    log.error("no usable certificate: %s", exc)
                    client_w.write(b"454 4.7.0 TLS not available due to temporary reason\r\n")
                    await client_w.drain()
                    continue
                client_w.write(b"220 2.0.0 Ready to start TLS\r\n")
                await client_w.drain()
                loop = asyncio.get_running_loop()
                transport = client_w.transport
                protocol = transport.get_protocol()
                try:
                    new_transport = await loop.start_tls(
                        transport, protocol, ctx, server_side=True, ssl_handshake_timeout=20
                    )
                except Exception as exc:
                    log.info("TLS handshake failed from %s: %s", peer[0], exc)
                    break
                # Re-bind the stream objects to the TLS transport. start_tls()
                # deliberately does not call connection_made() again, so the
                # StreamReaderProtocol still points at the plaintext transport.
                # Keep the plaintext writer alive: since Python 3.12,
                # StreamWriter.__del__ closes its transport when the object
                # is garbage-collected, which would tear down the very TCP
                # connection the TLS session now runs on.
                state["plain_w"] = client_w
                client_w = asyncio.StreamWriter(new_transport, protocol, client_r, loop)
                state["client_w"] = client_w
                protocol._stream_writer = client_w  # type: ignore[attr-defined]
                protocol._transport = new_transport  # type: ignore[attr-defined]
                protocol._over_ssl = True  # type: ignore[attr-defined]
                client_r._transport = new_transport  # type: ignore[attr-defined]
                state["tls"] = True
                cipher = new_transport.get_extra_info("cipher")
                log.info("STARTTLS ok from %s (%s)", peer[0], cipher[0] if cipher else "?")
                # The RFC says the client must EHLO again; the backend never saw the
                # STARTTLS, so nothing to reset on that side.
                continue
            if cmd.startswith(b"EHLO"):
                state["expect_ehlo_reply"] = True
            elif cmd.startswith(b"DATA"):
                state["in_data"] = True
            backend_w.write(line)
            await backend_w.drain()
    except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError) as exc:
        log.debug("client loop ended for %s: %s", peer[0], exc)
    except Exception:
        log.exception("unexpected error in client loop for %s", peer[0])
    finally:
        with_suppress_close(backend_w)
        b2c.cancel()
        with_suppress_close(client_w)
        log.info(
            "session closed %s tls=%s duration=%.1fs", peer[0], state["tls"], time.monotonic() - started
        )


async def main() -> None:
    try:
        CERTS.context()
    except Exception as exc:
        log.warning("certificate not loadable yet (%s) — STARTTLS will answer 454 until it is", exc)
    server = await asyncio.start_server(handle, host=None, port=LISTEN_PORT, reuse_address=True)
    addrs = ", ".join(str(s.getsockname()[:2]) for s in server.sockets)
    log.info("listening on %s → backend %s:%s (proxy protocol=%s)", addrs, BACKEND_HOST, BACKEND_PORT, PROXY_PROTOCOL)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
