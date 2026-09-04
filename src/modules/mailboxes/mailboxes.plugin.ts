import { Elysia, t } from "elysia";
import { createMailboxDto } from "./dtos/create-mailbox.dto.ts";
import { updateMailboxDto } from "./dtos/update-mailbox.dto.ts";
import { serializeMailbox } from "./serializations/mailbox.serialization.ts";
import * as mailboxService from "./services/mailbox.service.ts";
import { MailboxConflictError, MailboxValidationError } from "./errors.ts";
import { authMiddleware, adminMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

const MB = 1024 * 1024;

/**
 * Mailboxes plugin — IMAP mailbox management under /api/v1/mailboxes.
 *
 * Routes:
 * - POST   /        → Create a mailbox on a registered domain
 * - GET    /        → List mailboxes
 * - GET    /:id     → Get one mailbox (with client settings)
 * - PATCH  /:id     → Change password / quota / enabled
 * - DELETE /:id     → Delete a mailbox (row only; Maildir is kept on disk)
 *
 * Mailbox management is operator-level (it creates login credentials), so
 * every route is admin-only, like domains and api-keys.
 */
export const mailboxesPlugin = new Elysia({
  prefix: "/api/v1/mailboxes",
  normalize: true,
})
  .use(authMiddleware)
  .use(adminMiddleware)
  .use(rateLimitMiddleware)

  .post(
    "/",
    async ({ body, set }) => {
      logger.info("POST /api/v1/mailboxes", { email: body.email });
      try {
        const mailbox = await mailboxService.createMailbox({
          email: body.email,
          password: body.password,
          quotaBytes: body.quotaMb !== undefined ? body.quotaMb * MB : undefined,
        });
        set.status = 201;
        return { success: true, data: serializeMailbox(mailbox) };
      } catch (error) {
        if (error instanceof MailboxValidationError) {
          set.status = 400;
          return { success: false, error: error.message, code: "MAILBOX_INVALID" };
        }
        if (error instanceof MailboxConflictError) {
          set.status = 409;
          return { success: false, error: error.message, code: "MAILBOX_EXISTS" };
        }
        throw error;
      }
    },
    {
      body: createMailboxDto,
      detail: {
        tags: ["Mailboxes"],
        summary: "Create mailbox",
        description:
          "Creates an IMAP mailbox on a registered domain. The password is stored as a Dovecot-compatible bcrypt hash.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async () => {
      logger.info("GET /api/v1/mailboxes");
      const list = await mailboxService.listMailboxes();
      return { success: true, data: list.map(serializeMailbox) };
    },
    {
      detail: {
        tags: ["Mailboxes"],
        summary: "List mailboxes",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, set }) => {
      logger.info("GET /api/v1/mailboxes/:id", { mailboxId: params.id });
      const mailbox = await mailboxService.getMailboxById(params.id);
      if (!mailbox) {
        set.status = 404;
        return { success: false, error: "Mailbox not found" };
      }
      return { success: true, data: serializeMailbox(mailbox) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Mailboxes"],
        summary: "Get mailbox",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .patch(
    "/:id",
    async ({ params, body, set }) => {
      logger.info("PATCH /api/v1/mailboxes/:id", {
        mailboxId: params.id,
        fields: Object.keys(body),
      });
      try {
        const mailbox = await mailboxService.updateMailbox(params.id, {
          password: body.password,
          quotaBytes: body.quotaMb !== undefined ? body.quotaMb * MB : undefined,
          enabled: body.enabled,
        });
        if (!mailbox) {
          set.status = 404;
          return { success: false, error: "Mailbox not found" };
        }
        return { success: true, data: serializeMailbox(mailbox) };
      } catch (error) {
        if (error instanceof MailboxValidationError) {
          set.status = 400;
          return { success: false, error: error.message, code: "MAILBOX_INVALID" };
        }
        throw error;
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: updateMailboxDto,
      detail: {
        tags: ["Mailboxes"],
        summary: "Update mailbox",
        description: "Changes the password, quota, or enabled flag.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params, set }) => {
      logger.info("DELETE /api/v1/mailboxes/:id", { mailboxId: params.id });
      const mailbox = await mailboxService.deleteMailbox(params.id);
      if (!mailbox) {
        set.status = 404;
        return { success: false, error: "Mailbox not found" };
      }
      return { success: true, data: serializeMailbox(mailbox) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Mailboxes"],
        summary: "Delete mailbox",
        description:
          "Deletes the mailbox row. Existing mail on disk is kept until an operator removes it.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
