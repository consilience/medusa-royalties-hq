import type { PushLogger, PushNotice } from "../push/push"
import type { StoredSettings } from "../settings/settings"

/** rhq_state: what was last said about each month, so a repeating problem is told once. */
export const NOTICE_KEY = "last_notice"

export const EMAIL_TEMPLATES = {
  accepted: "royalties-hq-push-accepted",
  problem: "royalties-hq-push-problem",
} as const

/** Shaped like Medusa's Notification Module service. */
export type NotificationSender = { createNotifications(data: Record<string, unknown>): Promise<unknown> }

type StateStore = {
  readState<T = unknown>(key: string): Promise<T | null>
  writeState(key: string, value: unknown): Promise<void>
}

const totalsText = (totals: Record<string, string> | null) =>
  totals && Object.keys(totals).length
    ? Object.entries(totals)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([currency, amount]) => `${currency} ${amount}`)
        .join(", ")
    : null

function message(n: PushNotice): { subject: string; text: string } {
  if (n.kind === "accepted") {
    const lines = [
      `Royalties HQ accepted the sales snapshot for ${n.period}: ${n.rowCount ?? 0} rows${totalsText(n.totals) ? `, ${totalsText(n.totals)}` : ""}.`,
      ...(n.holdBackReasons.length ? [`Held back for review: ${n.holdBackReasons.join(", ")}.`] : []),
      n.importUrl ? `Review and import it: ${n.importUrl}` : "Review and import it in Royalties HQ.",
    ]
    return { subject: `Royalties HQ: ${n.period} sent`, text: lines.join("\n") }
  }
  const p = n.problem
  const lines = [
    `The sales snapshot for ${n.period} was not sent.`,
    p ? `${p.title}${p.detail ? `: ${p.detail}` : ""}` : "",
    n.stop
      ? "Sending has stopped until this is fixed. Open Royalties HQ in the store admin for details."
      : n.retryAt
        ? `It will be tried again at ${n.retryAt.toISOString()}.`
        : "Open Royalties HQ in the store admin to push it again.",
  ].filter(Boolean)
  return { subject: `Royalties HQ: ${n.period} not sent`, text: lines.join("\n") }
}

/**
 * The push step's notifier: the admin feed always, and email to
 * each notify_emails address on the `email` channel, with a plain-text body
 * any provider can render. Medusa's local provider only logs emails; a real
 * provider must be configured for them to arrive.
 *
 * A notice carries totals and counts only, never order or customer data.
 * Each send is isolated and its failure logged: the push already happened,
 * and an outage at the email provider must not hide the feed entry.
 */
export function createPushNotifier(deps: {
  notifications: NotificationSender | null
  state: StateStore
  settings: () => Promise<StoredSettings | null>
  logger?: PushLogger
}): (notice: PushNotice) => Promise<void> {
  const log = deps.logger ?? (() => {})
  return async (notice) => {
    if (!deps.notifications) return
    // Retries come every few minutes for a day: one message per change, not
    // one per attempt.
    const said = (await deps.state.readState<Record<string, string>>(NOTICE_KEY)) ?? {}
    // The outcome is part of the key: "will try again" and "has given up"
    // with the same code are different news.
    const outcome = notice.stop ? "stop" : notice.retryAt ? "retry" : "final"
    const key = notice.kind === "accepted" ? `accepted:${notice.attemptId}` : `problem:${notice.problem?.code ?? "unknown"}:${outcome}`
    if (said[notice.period] === key) return

    const { subject, text } = message(notice)
    const sends: { channel: string; payload: Record<string, unknown> }[] = [
      { channel: "feed", payload: { to: "", channel: "feed", template: "admin-ui", data: { title: subject, description: text } } },
    ]
    const emails = (await deps.settings())?.notify_emails ?? []
    for (const to of emails) {
      sends.push({
        channel: "email",
        payload: {
          to,
          channel: "email",
          template: EMAIL_TEMPLATES[notice.kind],
          data: { subject, text, period: notice.period, kind: notice.kind, import_url: notice.importUrl },
        },
      })
    }
    let delivered = false
    for (const s of sends) {
      try {
        await deps.notifications.createNotifications(s.payload)
        delivered = true
      } catch (error) {
        log({ event: "notify.failed", channel: s.channel, period: notice.period, error: error instanceof Error ? error.name : "Error" })
      }
    }
    // Only a notice that reached somewhere counts as said: with every
    // channel down, the next attempt's notice must try again.
    if (delivered) await deps.state.writeState(NOTICE_KEY, { ...said, [notice.period]: key })
  }
}
