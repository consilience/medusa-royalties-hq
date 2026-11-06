import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Badge,
  Button,
  Checkbox,
  Container,
  createDataTableColumnHelper,
  DataTable,
  Drawer,
  Heading,
  Input,
  Label,
  Text,
  Textarea,
  toast,
  useDataTable,
  type DataTablePaginationState,
  type DataTableRowSelectionState,
} from "@medusajs/ui"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { api, failureOf, type Component, type VariantRow } from "../../../lib/api"

const KEY = ["royalties-hq", "variants"]

// One component per line, "variant_id quantity"; a missing quantity is 1.
const parseComponents = (text: string): Component[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [variant_id, qty] = l.split(/\s+/)
      return { variant_id: variant_id!, quantity: qty ? Number(qty) : 1 }
    })
const formatComponents = (c: Component[] | null) => (c ?? []).map((x) => `${x.variant_id} ${x.quantity}`).join("\n")

function EditDrawer({ row, onClose }: { row: VariantRow; onClose: () => void }) {
  const qc = useQueryClient()
  const [include, setInclude] = useState(row.include)
  const [productId, setProductId] = useState(row.rhq_product_id ?? "")
  const [components, setComponents] = useState(formatComponents(row.bundle_components))
  const save = useMutation({
    mutationFn: () =>
      api.saveVariant(row.id, {
        include,
        rhq_product_id: productId.trim() || null,
        bundle_components: components.trim() ? parseComponents(components) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      toast.success("Saved")
      onClose()
    },
    onError: (e) => toast.error("Not saved", { description: failureOf(e).message }),
  })
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{[row.product_title, row.variant_title].filter(Boolean).join(" – ")}</Drawer.Title>
          <Drawer.Description className="sr-only">How this variant's sales are reported to Royalties HQ.</Drawer.Description>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-4">
          <div className="flex items-center gap-x-2">
            <Checkbox id="rhq-include" checked={include} onCheckedChange={(v) => setInclude(v === true)} />
            <Label htmlFor="rhq-include" size="small">
              Report this variant's sales to Royalties HQ
            </Label>
          </div>
          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus">
              Royalties HQ product id
            </Label>
            <Input value={productId} onChange={(e) => setProductId(e.target.value)} />
            <Text size="small" className="text-ui-fg-subtle">
              Optional. Matches the sale to a product in Royalties HQ when it has no ISBN.
            </Text>
          </div>
          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus">
              Bundle contents
            </Label>
            <Textarea rows={5} value={components} placeholder={"variant_01… 1\nvariant_02… 2"} onChange={(e) => setComponents(e.target.value)} />
            <Text size="small" className="text-ui-fg-subtle">
              For a box set or bundle: one variant id and quantity per line. Its sales are split across these books.
            </Text>
          </div>
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary">
              Cancel
            </Button>
          </Drawer.Close>
          <Button size="small" disabled={save.isPending} isLoading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

const column = createDataTableColumnHelper<VariantRow>()

const ProductsPage = () => {
  const qc = useQueryClient()
  const [pagination, setPagination] = useState<DataTablePaginationState>({ pageIndex: 0, pageSize: 50 })
  const [selection, setSelection] = useState<DataTableRowSelectionState>({})
  const [editing, setEditing] = useState<VariantRow | null>(null)
  const offset = pagination.pageIndex * pagination.pageSize
  const { data, isLoading } = useQuery({
    queryKey: [...KEY, offset, pagination.pageSize],
    queryFn: () => api.variants(offset, pagination.pageSize),
    placeholderData: keepPreviousData,
  })
  const bulk = useMutation({
    mutationFn: (include: boolean) => api.includeVariants(Object.keys(selection), include),
    onSuccess: (_d, include) => {
      qc.invalidateQueries({ queryKey: KEY })
      setSelection({})
      toast.success(include ? "Included" : "Excluded")
    },
    onError: (e) => toast.error(failureOf(e).message),
  })

  const columns = useMemo(
    () => [
      column.select(),
      column.accessor("product_title", {
        header: "Product",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.product_title}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.variant_title}
            </Text>
          </div>
        ),
      }),
      column.accessor("isbn", { header: "ISBN", cell: ({ getValue }) => getValue() ?? "–" }),
      column.accessor("sku", { header: "SKU", cell: ({ getValue }) => getValue() ?? "–" }),
      column.accessor("include", {
        header: "Reported",
        cell: ({ row }) => (
          <div className="flex gap-x-1">
            {row.original.include ? <Badge color="green" size="2xsmall">Included</Badge> : <Badge size="2xsmall">Not included</Badge>}
            {row.original.bundle_components?.length ? <Badge color="blue" size="2xsmall">Bundle</Badge> : null}
          </div>
        ),
      }),
      column.display({
        id: "edit",
        cell: ({ row }) => (
          <Button size="small" variant="transparent" onClick={() => setEditing(row.original)}>
            Edit
          </Button>
        ),
      }),
    ],
    [],
  )

  const table = useDataTable({
    data: data?.variants ?? [],
    columns,
    getRowId: (r) => r.id,
    rowCount: data?.count ?? 0,
    isLoading,
    pagination: { state: pagination, onPaginationChange: setPagination },
    rowSelection: { state: selection, onRowSelectionChange: setSelection },
  })
  const picked = Object.keys(selection).length

  return (
    <Container className="divide-y p-0">
      <DataTable instance={table}>
        <DataTable.Toolbar className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h2">Products reported to Royalties HQ</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Only included variants are reported. Tick the books you pay royalties on.
            </Text>
          </div>
          <div className="flex gap-x-2">
            <Button size="small" variant="secondary" disabled={!picked || bulk.isPending} onClick={() => bulk.mutate(false)}>
              Exclude {picked || ""}
            </Button>
            <Button size="small" disabled={!picked || bulk.isPending} isLoading={bulk.isPending} onClick={() => bulk.mutate(true)}>
              Include {picked || ""}
            </Button>
          </div>
        </DataTable.Toolbar>
        <DataTable.Table />
        <DataTable.Pagination />
      </DataTable>
      {editing && <EditDrawer row={editing} onClose={() => setEditing(null)} />}
    </Container>
  )
}

export const config = defineRouteConfig({ label: "Products" })

export default ProductsPage
