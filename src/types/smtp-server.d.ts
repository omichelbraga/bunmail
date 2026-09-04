import type { Socket } from "net";

/**
 * Type augmentation for `smtp-server`.
 *
 * `SMTPServer#connect(socket, socketOptions)` exists at runtime (it is how
 * `smtp-server` itself feeds accepted sockets into an `SMTPConnection`, and
 * is the documented hook for sockets accepted by an external server) but
 * is missing from `@types/smtp-server`. The SMTP submission module uses it
 * to hand TLS-terminated sockets from its own `tls.Server` to an
 * `SMTPServer({ secured: true })` — see
 * `src/modules/smtp-submission/services/smtp-submission.service.ts`.
 */
declare module "smtp-server" {
  interface SMTPServer {
    /**
     * Accept an already-established socket (plain or TLS-terminated
     * upstream) and run the SMTP session on it.
     */
    connect(socket: Socket, socketOptions?: Record<string, unknown>): void;
  }
}
