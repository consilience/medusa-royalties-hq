import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ChartBar } from "@medusajs/icons"
import { Badge, Button, Container, Heading, Table, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { pushableMonths, rowCount } from "../../lib/months"
import { api, failureOf, type ActionResult, type AttemptLine, type MonthLine, type StatusView } from "../../lib/api"

const KEY = ["royalties-hq", "status"]

const STATUS_BADGE: Record<string, { color: "green" | "orange" | "red" | "grey" | "blue"; label: string }> = {
  imported: { color: "green", label: "Imported" },
  staged: { color: "blue", label: "Staged in RHQ" },
  rejected: { color: "red", label: "Rejected" },
  failed: { color: "red", label: "Failed" },
  built: { color: "grey", label: "Built" },
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "")
const totalsText = (t: Record<string, string> | null) =>
  t
    ? Object.entries(t)
        .map(([c, a]) => `${c} ${a}`)
        .join(", ")
    : ""

function announce(result: ActionResult) {
  if (result.ok) toast.success(result.message)
  else toast.error(result.problem.title, { description: result.problem.detail ?? undefined })
}

function DeploymentNotice({ view }: { view: StatusView }) {
  const qc = useQueryClient()
  const confirm = useMutation({
    mutationFn: api.confirmDeployment,
    onSuccess: (data) => {
      qc.setQueryData(KEY, data)
      toast.success("This deployment now sends to Royalties HQ")
    },
    onError: (e) => toast.error(failureOf(e).message),
  })
  const d = view.deployment
  if (d.ok || !view.enabled) return null
  const text =
    d.code === "deployment_changed"
      ? `Sending was switched on at ${d.recordedOrigin}, and this is ${d.currentOrigin}. A copy of the store (staging, a laptop) must not send. If the store has really moved here, confirm it.`
      : d.code === "origin_unknown"
        ? "This deployment's address is not known. Set the plugin's backendUrl option or MEDUSA_BACKEND_URL; nothing is sent until then."
        : "Switch sending on again in Settings to record this deployment."
  return (
    <Container className="flex items-center justify-between gap-x-4 px-6 py-4">
      <div>
        <Text size="small" weight="plus">
          Live pushes are paused
        </Text>
        <Text size="small" className="text-ui-fg-subtle">
          {text}
        </Text>
      </div>
      {d.code === "deployment_changed" && (
        <Button size="small" variant="secondary" disabled={confirm.isPending} isLoading={confirm.isPending} onClick={() => confirm.mutate()}>
          The store moved here
        </Button>
      )}
    </Container>
  )
}


const FAILED = ["rejected", "failed", "refused", "unknown", "interrupted"]

function Attempt({ attempt: a }: { attempt: AttemptLine }) {
  const failed = FAILED.includes(a.state)
  return (
    <div className="flex flex-col">
      <Text size="small" className={failed ? "text-ui-fg-error" : undefined}>
        {a.mode === "dry_run" ? "Dry run" : a.mode === "test" ? "Test push" : a.trigger === "manual" ? "Pushed" : "Scheduled"}: {failed ? a.problem_title ?? a.state : a.state}
      </Text>
      <Text size="xsmall" className="text-ui-fg-subtle">
        {when(a.finished_at)}
        {a.retry_at ? ` · retrying ${when(a.retry_at)}` : ""}
      </Text>
    </div>
  )
}

function MonthRow({ month, canPush }: { month: MonthLine; canPush: boolean }) {
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.push(month.period, dryRun),
    onSuccess: (r) => {
      announce(r)
      qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (e) => toast.error(failureOf(e).message),
  })
  const download = useMutation({
    mutationFn: async () => {
      const res = await api.csv(month.period)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement("a")
      a.href = url
      a.download = `royalties-hq-${month.period}.csv`
      a.click()
      // Revoked at once, some browsers cancel the download.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    onError: (e) => toast.error(failureOf(e).message),
  })
  const badge = month.status ? STATUS_BADGE[month.status] : null

  return (
    <Table.Row>
      <Table.Cell>
        <Text size="small" weight="plus">
          {month.period}
        </Text>
      </Table.Cell>
      <Table.Cell>
        <div className="flex flex-col gap-y-1 py-2">
          {badge ? <Badge color={badge.color} size="2xsmall">{badge.label}</Badge> : <Badge size="2xsmall">Not sent</Badge>}
          {month.hold_back_notes.map((note) => (
            <Text key={note} size="xsmall" className="text-ui-fg-subtle">
              Held for review: {note}
            </Text>
          ))}
          {month.rhq_error_summary && (
            <Text size="xsmall" className="text-ui-fg-error">
              {month.rhq_error_summary}
            </Text>
          )}
        </div>
      </Table.Cell>
      <Table.Cell>
        <Text size="small">{rowCount(month.row_count)}</Text>
        <Text size="xsmall" className="text-ui-fg-subtle">
          {totalsText(month.totals)}
        </Text>
      </Table.Cell>
      <Table.Cell>
        <div className="flex flex-col gap-y-1 py-2">
          {month.last_attempt && <Attempt attempt={month.last_attempt} />}
          {month.last_dry_run && <Attempt attempt={month.last_dry_run} />}
        </div>
      </Table.Cell>
      <Table.Cell>
        <div className="flex justify-end gap-x-2">
          {month.import_url && (
            <Button size="small" variant="transparent" asChild>
              <a href={month.import_url} target="_blank" rel="noreferrer">
                Open in RHQ
              </a>
            </Button>
          )}
          <Button size="small" variant="secondary" disabled={download.isPending} isLoading={download.isPending} onClick={() => download.mutate()}>
            CSV
          </Button>
          {/* RHQ refuses a dry run of a month it has imported. */}
          {month.status !== "imported" && (
            <Button size="small" variant="secondary" disabled={run.isPending} onClick={() => run.mutate(true)}>
              Dry run
            </Button>
          )}
          {canPush && (
            <Button size="small" disabled={run.isPending} isLoading={run.isPending} onClick={() => run.mutate(false)}>
              Push now
            </Button>
          )}
        </div>
      </Table.Cell>
    </Table.Row>
  )
}

const RoyaltiesHqPage = () => {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: api.status })
  const check = useMutation({
    mutationFn: api.checkImports,
    onSuccess: (r) => {
      announce(r)
      qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (e) => toast.error(failureOf(e).message),
  })
  // Until a handshake confirms the new token's connection, the months shown
  // are not that connection's, so none is offered for a push.
  const pushable = data ? pushableMonths(data.months, { enabled: data.enabled && !data.connection_unconfirmed }) : new Set<string>()

  return (
    <div className="flex flex-col gap-y-3">
      {data && <DeploymentNotice view={data} />}
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h1">Royalties HQ</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {!data
                ? ""
                : !data.enabled
                  ? "Sending is off. Turn it on in Settings → Royalties HQ; CSV downloads and dry runs work meanwhile."
                  : data.push_mode === "manual"
                    ? "Manual mode: nothing is sent until you push a month, oldest first."
                    : `Each month is sent on its push day${data.marketplace ? ` to ${data.marketplace}` : ""}.`}
              {data?.planned ? ` Next try at ${when(data.planned.at)} for ${data.planned.periods.join(", ")}.` : ""}
            </Text>
          </div>
          <Button size="small" variant="secondary" disabled={!data?.connected || check.isPending} isLoading={check.isPending} onClick={() => check.mutate()}>
            Check RHQ status
          </Button>
        </div>
        {isLoading && (
          <Text size="small" className="px-6 py-4">
            Loading…
          </Text>
        )}
        {error && (
          <Text size="small" className="px-6 py-4">
            {failureOf(error).message}
          </Text>
        )}
        {data?.connection_unconfirmed && (
          <Text size="small" className="px-6 py-4">
            The token changed. Use Test connection in Settings → Royalties HQ to show the months of the connection it belongs to.
          </Text>
        )}
        {data && data.months.length === 0 && (
          <Text size="small" className="text-ui-fg-subtle px-6 py-4">
            Choose the first month to send in Settings → Royalties HQ.
          </Text>
        )}
        {data && data.months.length > 0 && (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Month</Table.HeaderCell>
                <Table.HeaderCell>Royalties HQ</Table.HeaderCell>
                <Table.HeaderCell>Sent</Table.HeaderCell>
                <Table.HeaderCell>Last attempt</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.months.map((m) => (
                <MonthRow key={m.period} month={m} canPush={pushable.has(m.period)} />
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>
    </div>
  )
}

export const config = defineRouteConfig({ label: "Royalties HQ", icon: ChartBar })

export default RoyaltiesHqPage
