import type { MedusaContainer } from "@medusajs/framework/types"
import { pushDepsFrom } from "../lib/medusa/push-deps"
import { runTick } from "../lib/push/tick"

// Every five minutes: cheap when nothing is due (two state reads), and the
// push moment is spread over minutes per store, so an hourly tick would
// push up to an hour late. The schedule is fixed because plugin options do
// not reach jobs; whether to send is read from the settings inside.
export default async function royaltiesHqTick(container: MedusaContainer) {
  await runTick(await pushDepsFrom(container))
}

export const config = {
  name: "royalties-hq-tick",
  schedule: "*/5 * * * *",
}
