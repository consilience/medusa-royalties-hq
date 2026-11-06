import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Checkbox, Container, Heading, Input, Label, Select, Switch, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type ReactNode } from "react"
import { api, failureOf, type Settings, type SettingsView } from "../../../lib/api"
import { feeOptions, lastMonth } from "../../../lib/settings-form"

const QUERY_KEY = ["royalties-hq", "settings"]

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-y-2">
      <Label size="small" weight="plus">
        {label}
      </Label>
      {children}
      {hint && (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {hint}
        </Text>
      )}
    </div>
  )
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)} size="small">
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {options.map(([v, label]) => (
          <Select.Item key={v} value={v}>
            {label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select>
  )
}

function TokenSection({ view }: { view: SettingsView }) {
  const qc = useQueryClient()
  const [token, setToken] = useState("")
  const done = (data: SettingsView, message: string) => {
    qc.setQueryData(QUERY_KEY, data)
    setToken("")
    toast.success(message)
  }
  const put = useMutation({ mutationFn: () => api.putToken(token), onSuccess: (d) => done(d, "Token saved"), onError: (e) => toast.error(failureOf(e).message) })
  const del = useMutation({ mutationFn: api.deleteToken, onSuccess: (d) => done(d, "Token removed"), onError: (e) => toast.error(failureOf(e).message) })
  const test = useMutation({
    mutationFn: api.testConnection,
    onSuccess: (r: any) =>
      r.ok
        ? toast.success(`Connected to ${r.connection.name}`, { description: `${r.connection.tokenMode === "test" ? "Test" : "Live"} token, ${r.connection.currency}` })
        : toast.error(r.problem.title, { description: r.problem.detail ?? undefined }),
    onError: (e) => toast.error(failureOf(e).message),
  })
  const t = view.token

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">API token</Heading>
        {t.set ? <Badge color={t.testMode ? "orange" : "green"} size="2xsmall">{t.testMode ? "Test token" : "Live token"} ending {t.lastFour}</Badge> : <Badge size="2xsmall">Not set</Badge>}
      </div>
      <div className="flex flex-col gap-y-4 px-6 py-4">
        {t.source === "env" ? (
          <Text size="small" className="text-ui-fg-subtle">
            The token is set on the server by ROYALTIES_HQ_API_TOKEN; change it there.
          </Text>
        ) : (
          <Field label={t.set ? "Replace the token" : "Token"} hint="Shown once in Royalties HQ when you create the connection. It is stored encrypted and never shown again.">
            {/* Write-only: the stored token is never sent back to this page. */}
            <Input type="password" autoComplete="off" placeholder="rhq_live_…" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        )}
        <div className="flex gap-x-2">
          {t.source !== "env" && (
            <Button size="small" disabled={!token || put.isPending} isLoading={put.isPending} onClick={() => put.mutate()}>
              Save token
            </Button>
          )}
          <Button size="small" variant="secondary" disabled={!t.set || test.isPending} isLoading={test.isPending} onClick={() => test.mutate()}>
            Test connection
          </Button>
          {t.source === "stored" && (
            <Button size="small" variant="danger" disabled={del.isPending} isLoading={del.isPending} onClick={() => del.mutate()}>
              Remove token
            </Button>
          )}
        </div>
      </div>
    </Container>
  )
}

function SettingsForm({ view }: { view: SettingsView }) {
  const qc = useQueryClient()
  const [s, setS] = useState<Settings>(view.settings)
  const [emails, setEmails] = useState(view.settings.notify_emails.join(", "))
  useEffect(() => {
    setS(view.settings)
    setEmails(view.settings.notify_emails.join(", "))
  }, [view.version])
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }))
  const blankToNull = (v: string) => (v.trim() === "" ? null : v.trim())

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        ...s,
        start_month: s.start_month ?? (s.enabled ? lastMonth(s.timezone) : null),
        notify_emails: emails.split(/[\s,;]+/).filter(Boolean),
      }),
    onSuccess: (data) => {
      qc.setQueryData(QUERY_KEY, data)
      toast.success("Settings saved")
    },
    onError: (e) => toast.error("Settings not saved", { description: failureOf(e).message }),
  })

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Connection and schedule</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Monthly sales snapshots, net of tax, with no customer data.
          </Text>
        </div>
        <div className="flex items-center gap-x-2">
          <Label htmlFor="rhq-enabled" size="small">
            Sending on
          </Label>
          <Switch id="rhq-enabled" checked={s.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        <Field label="API base URL" hint="From Royalties HQ, ending /api/v1.">
          <Input value={s.base_url ?? ""} placeholder="https://app.royaltieshq.com/api/v1" onChange={(e) => set("base_url", blankToNull(e.target.value))} />
        </Field>
        <Field label="Push mode" hint="Manual sends nothing until you push a month from the Royalties HQ page.">
          <Choice value={s.push_mode} onChange={(v) => set("push_mode", v)} options={[["automatic", "Automatic"], ["manual", "Manual"]]} />
        </Field>
        <Field label="First month to send" hint="Nothing earlier is sent or offered.">
          <Input type="month" value={s.start_month ?? ""} onChange={(e) => set("start_month", blankToNull(e.target.value))} />
        </Field>
        <Field label="Store time zone" hint="Months begin and end at midnight here. An IANA name, such as Europe/London.">
          <Input value={s.timezone ?? ""} placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={(e) => set("timezone", blankToNull(e.target.value))} />
        </Field>
        <Field label="Country of sale" hint="Two letters, such as GB.">
          <Input value={s.sale_country ?? ""} maxLength={2} onChange={(e) => set("sale_country", blankToNull(e.target.value.toUpperCase()))} />
        </Field>
        <Field label="Push day" hint="Day of the month after a period ends (1–28).">
          <Input type="number" min={1} max={28} value={s.push_day} onChange={(e) => set("push_day", Number(e.target.value))} />
        </Field>
        <Field label="Months per period">
          <Choice
            value={String(s.frequency_months)}
            onChange={(v) => set("frequency_months", Number(v))}
            options={[["1", "Monthly"], ["3", "Quarterly"], ["6", "Half-yearly"], ["12", "Yearly"]]}
          />
        </Field>
        <Field label="First month of a period" hint="1 is January.">
          <Input type="number" min={1} max={12} value={s.anchor_month} onChange={(e) => set("anchor_month", Number(e.target.value))} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        <Field label="Commission (%)" hint="Deducted from net receipts, if your contracts pay on net after commission.">
          <Input value={s.commission_percent ?? ""} placeholder="0" onChange={(e) => set("commission_percent", blankToNull(e.target.value))} />
        </Field>
        <Field label="Card fees">
          <Choice value={s.card_fee_mode} onChange={(v) => set("card_fee_mode", v)} options={feeOptions(s.card_fee_mode)} />
        </Field>
        {s.card_fee_mode === "flat" && (
          <Field label="Card fee (%)">
            <Input value={s.card_fee_flat_percent ?? ""} onChange={(e) => set("card_fee_flat_percent", blankToNull(e.target.value))} />
          </Field>
        )}
        {s.card_fee_mode !== "none" && s.commission_percent && (
          <div className="flex items-start gap-x-2">
            <Checkbox id="rhq-fees" checked={s.commission_excludes_fees_confirmed} onCheckedChange={(v) => set("commission_excludes_fees_confirmed", v === true)} />
            <Label htmlFor="rhq-fees" size="small">
              The commission does not already include card fees
            </Label>
          </div>
        )}
        <Field label="Bundles without a set split">
          <Choice value={s.bundle_split} onChange={(v) => set("bundle_split", v)} options={[["price_ratio", "Split by the books' prices"], ["even", "Split evenly"]]} />
        </Field>
        <Field label="ISBN from">
          <Choice
            value={s.isbn_source}
            onChange={(v) => set("isbn_source", v)}
            options={[["auto", "First that is an ISBN"], ["ean", "EAN"], ["barcode", "Barcode"], ["upc", "UPC"], ["sku", "SKU"]]}
          />
        </Field>
        <div className="flex items-center gap-x-2">
          <Switch id="rhq-shipping" checked={s.include_shipping} onCheckedChange={(v) => set("include_shipping", v)} />
          <Label htmlFor="rhq-shipping" size="small">
            Count shipping as part of net receipts
          </Label>
        </div>
        <Field label="Email notices to" hint="Comma-separated. Needs an email provider configured in Medusa; the admin feed always gets them.">
          <Input value={emails} onChange={(e) => setEmails(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end px-6 py-4">
        <Button size="small" disabled={save.isPending} isLoading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Container>
  )
}

const RoyaltiesHqSettingsPage = () => {
  const { data, isLoading, error } = useQuery({ queryKey: QUERY_KEY, queryFn: api.settings })
  return (
    <div className="flex flex-col gap-y-3">
      {isLoading && <Text size="small">Loading…</Text>}
      {error && <Text size="small">{failureOf(error).message}</Text>}
      {data && (
        <>
          <TokenSection view={data} />
          <SettingsForm view={data} />
        </>
      )}
    </div>
  )
}

export const config = defineRouteConfig({ label: "Royalties HQ" })

export default RoyaltiesHqSettingsPage
