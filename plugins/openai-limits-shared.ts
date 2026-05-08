import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Auth = {
  type: string
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
}

export type WindowInfo = {
  used: number
  resetAt?: number
  seconds?: number
  label: "5h" | "week" | "other"
}

export type Account = {
  id: string
  name: string
}

type ProviderConfig = {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, unknown>
  [key: string]: unknown
}

type OpenCodeConfig = {
  $schema?: string
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

export const DATA_DIR = join(homedir(), ".local", "share", "opencode")
export const CONFIG_FILE = join(homedir(), ".config", "opencode", "opencode.jsonc")
export const AUTH_FILE = join(DATA_DIR, "auth.json")
export const CACHE_FILE = join(DATA_DIR, "openai-limits.json")
export const REFRESH_REQUEST_FILE = join(DATA_DIR, "openai-limits.refresh")
export const OPENAI_PROVIDER_NPM = "@ai-sdk/openai"
export const OPENAI_LOGIN_METHOD = "ChatGPT Pro/Plus (browser)"

const DEFAULT_MODEL_ID = "gpt-5.5"

function jsoncToJson(input: string) {
  let output = ""
  let inString = false
  let escape = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const next = input[index + 1]

    if (inString) {
      output += char
      if (escape) {
        escape = false
      } else if (char === "\\") {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index++
      output += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        if (input[index] === "\n") output += "\n"
        index++
      }
      index++
      continue
    }

    output += char
  }

  return output.replace(/,\s*([}\]])/g, "$1")
}

function readJsoncFile<Value>(file: string, fallback: Value): Value {
  try {
    return JSON.parse(jsoncToJson(readFileSync(file, "utf8"))) as Value
  } catch {
    return fallback
  }
}

function readJsoncFileStrict<Value>(file: string, fallback: Value): Value {
  if (!existsSync(file)) return fallback
  return JSON.parse(jsoncToJson(readFileSync(file, "utf8"))) as Value
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

export function readAuthMap() {
  return readJsoncFile<Record<string, Auth>>(AUTH_FILE, {})
}

function readAuthMapForWrite() {
  try {
    return readJsoncFileStrict<Record<string, Auth>>(AUTH_FILE, {})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`could not parse auth.json: ${message}`)
  }
}

export function readConfig() {
  return readJsoncFile<OpenCodeConfig>(CONFIG_FILE, {})
}

function readConfigForWrite() {
  try {
    return readJsoncFileStrict<OpenCodeConfig>(CONFIG_FILE, {})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`could not parse opencode.jsonc: ${message}`)
  }
}

export function writeConfig(config: OpenCodeConfig) {
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

export function parseJwtClaims(token?: string) {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, any>
  } catch {
    return undefined
  }
}

export function accountIDFromClaims(claims?: Record<string, any>) {
  return claims?.chatgpt_account_id || claims?.["https://api.openai.com/auth"]?.chatgpt_account_id || claims?.organizations?.[0]?.id
}

export function accountIDFromTokens(tokens: Auth) {
  return tokens.accountId || accountIDFromClaims(parseJwtClaims(tokens.access))
}

export function isSafeProviderID(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
}

export function providerNameFromID(id: string) {
  if (id === "openai") return "OpenAI"
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

function isOpenAIProviderConfig(id: string, provider?: ProviderConfig) {
  if (id === "openai") return true
  if (!provider || typeof provider !== "object") return false
  const npm = String(provider.npm || "")
  const baseURL = String(provider.options?.baseURL || "")
  if (npm === OPENAI_PROVIDER_NPM) return true
  if (id.startsWith("openai") && npm.includes("openai")) return true
  return baseURL.startsWith("https://api.openai.com")
}

function isOpenAIAuthCandidate(id: string, auth: Auth, provider?: ProviderConfig) {
  if (auth.type !== "oauth") return false
  if (isOpenAIProviderConfig(id, provider)) return true
  if (id === "openai" || id.startsWith("openai")) return true
  const claims = parseJwtClaims(auth.access)
  return Boolean(claims?.chatgpt_account_id || claims?.["https://api.openai.com/auth"]?.chatgpt_account_id)
}

export function discoverOpenAIAccounts(authMap = readAuthMap()) {
  const config = readConfigForWrite()
  const providers = config.provider || {}
  const byId = new Map<string, Account>()

  const add = (id: string, provider?: ProviderConfig) => {
    if (!id || byId.has(id)) return
    byId.set(id, { id, name: provider?.name || providerNameFromID(id) })
  }

  if (authMap.openai || providers.openai) add("openai", providers.openai)

  for (const [id, provider] of Object.entries(providers)) {
    if (isOpenAIProviderConfig(id, provider)) add(id, provider)
  }

  for (const [id, auth] of Object.entries(authMap)) {
    if (isOpenAIAuthCandidate(id, auth, providers[id])) add(id, providers[id])
  }

  if (!byId.size) add("openai", providers.openai)
  return Array.from(byId.values())
}

function defaultModels() {
  return {
    [DEFAULT_MODEL_ID]: {
      name: "GPT-5.5",
      reasoning: true,
      tool_call: true,
      limit: {
        context: 400000,
        input: 272000,
        output: 128000,
      },
      variants: {
        xhigh: {
          reasoningEffort: "xhigh",
          textVerbosity: "low",
          reasoningSummary: "auto",
        },
      },
    },
  }
}

function templateModels(config: OpenCodeConfig) {
  const providers = config.provider || {}
  for (const [id, provider] of Object.entries(providers)) {
    if (isOpenAIProviderConfig(id, provider) && provider.models) return clone(provider.models)
  }
  return defaultModels()
}

export function addOpenAIProvider(providerID: string, name = providerNameFromID(providerID)) {
  const id = providerID.trim()
  if (!isSafeProviderID(id)) throw new Error("provider id must use letters, numbers, dot, dash, or underscore")

  const config = readConfig()
  config.provider = config.provider || {}
  if (config.provider[id]) throw new Error(`provider '${id}' already exists`)

  config.provider[id] = {
    npm: OPENAI_PROVIDER_NPM,
    name,
    options: {
      baseURL: "https://api.openai.com/v1",
    },
    models: templateModels(config),
  }
  writeConfig(config)
  return { id, name }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function removeOpenAIProvider(providerID: string) {
  const id = providerID.trim()
  if (!isSafeProviderID(id)) throw new Error("provider id must use letters, numbers, dot, dash, or underscore")
  if (id === "openai") throw new Error("cannot remove built-in OpenAI provider")

  const config = readConfigForWrite()
  const removedProvider = Boolean(config.provider?.[id])
  if (config.provider) delete config.provider[id]
  writeConfig(config)

  const authMap = readAuthMapForWrite()
  const removedAuth = Object.prototype.hasOwnProperty.call(authMap, id)
  if (removedAuth) {
    delete authMap[id]
    writeJson(AUTH_FILE, authMap)
  }

  let removedCache = false
  try {
    const cache = readJsoncFileStrict<{ accounts?: any[] } & Record<string, unknown>>(CACHE_FILE, {})
    if (Array.isArray(cache.accounts)) {
      const accounts = cache.accounts.filter((account) => account?.id !== id)
      removedCache = accounts.length !== cache.accounts.length
      if (removedCache) writeJson(CACHE_FILE, { ...cache, accounts, updatedAt: Date.now() })
    }
  } catch {
    // Cache is disposable; writer will rebuild it on next refresh.
  }

  writeJson(REFRESH_REQUEST_FILE, { requestedAt: Date.now() })
  return { id, removedProvider, removedAuth, removedCache }
}
