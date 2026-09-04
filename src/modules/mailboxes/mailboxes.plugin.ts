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
 * - POST   /:id/aliases           → Add an alias address that delivers here
 * - DELETE /:id/aliases/:aliasId  → Remove an alias
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
      const aliases = await mailboxService.listAliasesByMailbox(list.map((m) => m.id));
      return {
        success: true,
        data: list.map((m) => serializeMailbox(m, aliases.get(m.id) ?? [])),
      };
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
      const aliases = await mailboxService.listAliases(mailbox.id);
      return { success: true, data: serializeMailbox(mailbox, aliases) };
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
  )

  .post(
    "/:id/aliases",
    async ({ params, body, set }) => {
      logger.info("POST /api/v1/mailboxes/:id/aliases", {
        mailboxId: params.id,
        alias: body.email,
      });
      try {
        const alias = await mailboxService.createAlias(params.id, body.email);
        set.status = 201;
        return {
          success: true,
          data: {
            id: alias.id,
            email: alias.email,
            createdAt: alias.createdAt.toISOString(),
          },
        };
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
      params: t.Object({ id: t.String() }),
      body: t.Object({ email: t.String({ format: "email", maxLength: 255 }) }),
      detail: {
        tags: ["Mailboxes"],
        summary: "Add alias",
        description:
          "Adds an address (on a registered domain) that delivers into this mailbox and that the mailbox may send From.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id/aliases/:aliasId",
    async ({ params, set }) => {
      logger.info("DELETE /api/v1/mailboxes/:id/aliases/:aliasId", {
        mailboxId: params.id,
        aliasId: params.aliasId,
      });
      const alias = await mailboxService.deleteAlias(params.id, params.aliasId);
      if (!alias) {
        set.status = 404;
        return { success: false, error: "Alias not found" };
      }
      return {
        success: true,
        data: {
          id: alias.id,
          email: alias.email,
          createdAt: alias.createdAt.toISOString(),
        },
      };
    },
    {
      params: t.Object({ id: t.String(), aliasId: t.String() }),
      detail: {
        tags: ["Mailboxes"],
        summary: "Remove alias",
        security: [{ bearerAuth: [] }],
      },
    },
  );
