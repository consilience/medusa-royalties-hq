const { existsSync } = require("node:fs")
const { resolve } = require("node:path")
const { loadEnv } = require("@medusajs/framework/utils")
loadEnv("test", process.cwd())

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
          target: "es2021",
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
}

const localSetup = resolve(__dirname, "jest.local.setup.ts")
if (existsSync(localSetup)) module.exports.setupFilesAfterEnv = [localSetup]

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.spec.[jt]s"]
  module.exports.testPathIgnorePatterns = ["\\.unit\\.spec\\.[jt]s$"]
} else if (process.env.TEST_TYPE === "e2e") {
  module.exports.testMatch = ["**/integration-tests/e2e/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = [
    "**/src/**/__tests__/**/*.unit.spec.[jt]s",
    "**/scripts/__tests__/*.unit.spec.[jt]s",
  ]
}
