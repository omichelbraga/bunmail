import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import type {
  Mailbox,
  MailboxAlias,
  MailboxClientSettings,
} from "../../modules/mailboxes/types/mailbox.types.ts";
import type { Domain } from "../../modules/domains/types/domain.types.ts";

/** Props for the mailboxes page. */
interface MailboxesPageProps {
  mailboxes: Mailbox[];
  /** Registered domains — a mailbox can only be created on one of these. */
  domains: Domain[];
  /** Connection settings shared by every mailbox (username differs). */
  clientSettings: Omit<MailboxClientSettings, "username">;
  /** Default quota for the create form, in MB. */
  defaultQuotaMb: number;
  /** Whether LMTP delivery / SMTP AUTH are switched on (`MAILBOXES_ENABLED`). */
  mailboxesEnabled: boolean;
  /** Aliases per mailbox id (support@ → mike@). */
  aliasesByMailbox?: Record<string, MailboxAlias[]>;
  flash?: { message: string; type: "success" | "error" };
}

const MB = 1024 * 1024;

/** Formats a byte count as a compact MB / GB string. */
function formatQuota(bytes: number): string {
  if (bytes >= 1024 * MB) {
    const gb = bytes / (1024 * MB);
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(bytes / MB)} MB`;
}

const inputClass =
  "px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent";
const primaryButtonClass =
  "px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap";
const linkButtonClass =
  "text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 font-medium";

/**
 * Mailboxes page — IMAP mailboxes backed by Dovecot.
 *
 * Create form (local part + registered domain + password + quota), a
 * "mail client settings" card operators can copy to users, and a table
 * with per-row actions: change password, set quota, enable/disable,
 * delete.
 */
export function MailboxesPage({
  mailboxes,
  domains,
  clientSettings,
  defaultQuotaMb,
  mailboxesEnabled,
  aliasesByMailbox = {},
  flash,
}: MailboxesPageProps) {
  return (
    <BaseLayout title="Mailboxes" activeNav="mailboxes">
      <h1 class="text-xl font-semibold mb-1">Mailboxes</h1>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Real IMAP mailboxes for Outlook, Thunderbird, Apple Mail and phones. Mail for a
        mailbox is delivered to Dovecot and still shows up under Inbound, logs and
        webhooks.
      </p>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {!mailboxesEnabled && (
        <FlashMessage
          type="error"
          message="MAILBOXES_ENABLED is false — mailboxes can be managed but inbound mail is not delivered to Dovecot and mailbox credentials are not accepted for SMTP. Set MAILBOXES_ENABLED=true to activate."
        />
      )}

      {/* Client settings */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Mail client settings
          </h2>
          <button
            type="button"
            class={linkButtonClass}
            onclick="navigator.clipboard.writeText(document.getElementById('mailbox-settings-text').textContent).then(function(){var b=event.target;b.textContent='Copied!';setTimeout(function(){b.textContent='Copy settings';},1500);})"
          >
            Copy settings
          </button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <p class="font-medium text-gray-700 dark:text-gray-300 mb-1">
              Incoming (IMAP)
            </p>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-gray-600 dark:text-gray-400">
              <dt>Server</dt>
              <dd class="font-mono" safe>
                {clientSettings.imap.host}
              </dd>
              <dt>Port</dt>
              <dd class="font-mono">{clientSettings.imap.port}</dd>
              <dt>Security</dt>
              <dd>{clientSettings.imap.security}</dd>
            </dl>
          </div>
          <div>
            <p class="font-medium text-gray-700 dark:text-gray-300 mb-1">
              Outgoing (SMTP)
            </p>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-gray-600 dark:text-gray-400">
              <dt>Server</dt>
              <dd class="font-mono" safe>
                {clientSettings.smtp.host}
              </dd>
              <dt>Port</dt>
              <dd class="font-mono">{clientSettings.smtp.port}</dd>
              <dt>Security</dt>
              <dd>{clientSettings.smtp.security}</dd>
            </dl>
          </div>
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-3">
          Username is the full mailbox address; password is the mailbox password, for both
          IMAP and SMTP.
        </p>
        <pre id="mailbox-settings-text" class="hidden" safe>
          {[
            `Incoming (IMAP): ${clientSettings.imap.host}, port ${clientSettings.imap.port}, ${clientSettings.imap.security}`,
            `Outgoing (SMTP): ${clientSettings.smtp.host}, port ${clientSettings.smtp.port}, ${clientSettings.smtp.security}`,
            `Username: your full email address`,
            `Password: your mailbox password`,
          ].join("\n")}
        </pre>
      </div>

      {/* Create form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        {domains.length === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Register a domain under{" "}
            <a href="/dashboard/domains" class="underline">
              Domains
            </a>{" "}
            before creating a mailbox.
          </p>
        ) : (
          <form method="POST" action="/dashboard/mailboxes" class="space-y-3">
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                name="localPart"
                required
                placeholder="user"
                pattern="[A-Za-z0-9._+\-]{1,64}"
                title="Letters, digits, . _ + - (max 64)"
                class={`${inputClass} flex-1`}
              />
              <span class="self-center text-gray-500 dark:text-gray-400">@</span>
              <select name="domain" required class={`${inputClass} flex-1`}>
                {domains.map((d) => (
                  <option value={d.name} safe>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div class="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                name="password"
                required
                minlength="10"
                autocomplete="new-password"
                placeholder="Password (min 10 characters)"
                class={`${inputClass} flex-1`}
              />
              <div class="flex items-center gap-2">
                <input
                  type="number"
                  name="quotaMb"
                  min="1"
                  value={String(defaultQuotaMb)}
                  class={`${inputClass} w-28`}
                />
                <span class="text-sm text-gray-500 dark:text-gray-400">MB quota</span>
              </div>
              <button type="submit" class={primaryButtonClass}>
                Create Mailbox
              </button>
            </div>
          </form>
        )}
      </div>

      {mailboxes.length === 0 ? (
        <EmptyState message="No mailboxes yet. Create one above to give someone an inbox." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Address
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Quota
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Created
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Aliases
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Password
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              {mailboxes.map((mailbox) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors align-top">
                  <td
                    class="px-4 py-3 font-mono text-xs text-gray-900 dark:text-gray-100"
                    safe
                  >
                    {mailbox.email}
                  </td>
                  <td class="px-4 py-3">
                    {mailbox.enabled ? (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        Enabled
                      </span>
                    ) : (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        Disabled
                      </span>
                    )}
                  </td>
                  <td class="px-4 py-3">
                    <form
                      method="POST"
                      action={`/dashboard/mailboxes/${mailbox.id}/quota`}
                      class="flex items-center gap-1.5"
                    >
                      <input
                        type="number"
                        name="quotaMb"
                        min="1"
                        value={String(Math.round(mailbox.quotaBytes / MB))}
                        class={`${inputClass} w-24 py-1`}
                      />
                      <span class="text-xs text-gray-500 dark:text-gray-400">MB</span>
                      <button type="submit" class={linkButtonClass}>
                        Save
                      </button>
                    </form>
                    <p class="text-xs text-gray-400 dark:text-gray-500 mt-1" safe>
                      {formatQuota(mailbox.quotaBytes)}
                    </p>
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <TimeDisplay value={mailbox.createdAt} />
                  </td>
                  <td class="px-4 py-3 min-w-[220px]">
                    <ul class="space-y-1 mb-1.5">
                      {(aliasesByMailbox[mailbox.id] ?? []).map((alias) => (
                        <li class="flex items-center gap-2 text-xs">
                          <span class="font-mono text-gray-700 dark:text-gray-300" safe>
                            {alias.email}
                          </span>
                          <form
                            method="POST"
                            action={`/dashboard/mailboxes/${mailbox.id}/aliases/${alias.id}/delete`}
                            class="inline"
                          >
                            <button
                              type="submit"
                              class="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
                              onclick="return confirm('Remove this alias?')"
                            >
                              remove
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                    <form
                      method="POST"
                      action={`/dashboard/mailboxes/${mailbox.id}/aliases`}
                      class="flex items-center gap-1.5"
                    >
                      <input
                        type="email"
                        name="email"
                        required
                        placeholder={`support@${mailbox.email.split("@")[1] ?? ""}`}
                        class={`${inputClass} w-44 py-1`}
                      />
                      <button type="submit" class={linkButtonClass}>
                        Add
                      </button>
                    </form>
                  </td>
                  <td class="px-4 py-3">
                    <form
                      method="POST"
                      action={`/dashboard/mailboxes/${mailbox.id}/password`}
                      class="flex items-center gap-1.5"
                    >
                      <input
                        type="password"
                        name="password"
                        required
                        minlength="10"
                        autocomplete="new-password"
                        placeholder="New password"
                        class={`${inputClass} w-40 py-1`}
                      />
                      <button type="submit" class={linkButtonClass}>
                        Change
                      </button>
                    </form>
                  </td>
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-3">
                      <form
                        method="POST"
                        action={`/dashboard/mailboxes/${mailbox.id}/toggle`}
                      >
                        <input
                          type="hidden"
                          name="enabled"
                          value={mailbox.enabled ? "false" : "true"}
                        />
                        <button type="submit" class={linkButtonClass}>
                          {mailbox.enabled ? "Disable" : "Enable"}
                        </button>
                      </form>
                      <form
                        method="POST"
                        action={`/dashboard/mailboxes/${mailbox.id}/delete`}
                      >
                        <button
                          type="submit"
                          class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                          onclick="return confirm('Delete this mailbox? The login stops working immediately. Stored mail stays on disk until an operator removes it.')"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BaseLayout>
  );
}
