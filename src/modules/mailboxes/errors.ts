/**
 * Thrown when mailbox input fails validation (bad address, weak password,
 * unregistered domain, non-positive quota). Mapped to HTTP 400 by the
 * mailboxes plugin and to a flash message by the dashboard.
 */
export class MailboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxValidationError";
  }
}

/**
 * Thrown when a mailbox with the same address already exists.
 * Mapped to HTTP 409.
 */
export class MailboxConflictError extends Error {
  constructor(public readonly email: string) {
    super(`Mailbox "${email}" already exists`);
    this.name = "MailboxConflictError";
  }
}
