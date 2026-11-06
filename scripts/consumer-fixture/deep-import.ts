// A deep import of an internal file. `exports` doesn't list the path, so
// scripts/install-test.sh expects TS2307 here.
import { pushMonth } from "@royaltieshq/medusa-royalties-hq/lib/push/push"

export { pushMonth }
