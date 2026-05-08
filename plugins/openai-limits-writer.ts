import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  CACHE_FILE,
  REFRESH_REQUEST_FILE,
  accountIDFromClaims,
  accountIDFromTokens,
  discoverOpenAIAccounts,
  parseJwtClaims,
  readAuthMap,
  type Account,
  type Auth,
  type WindowInfo,
} from "./openai-limits-shared.ts"

type CookieJar = {
  cookies: Map<string, string>
  expires: number
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
const REFRESH_MS = 2 * 60 * 1000
const HTTP_TIMEOUT_MS = 12_000

const tokenCache = new Map<string, Auth>()
let running = false
let pending = false
let lastRefreshRequestMtime = 0
const STARTED_KEY = Symbol.for("opencode.openai-limits-writer.started")

async function fetchTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function refreshToken(providerID: string, auth: Auth) {
  const cached = tokenCache.get(providerID)
  if (cached?.refresh === auth.refresh && cached.access && (cached.expires || 0) > Date.now() + 30_000) return cached
  if (auth.access && (auth.expires || 0) > Date.now() + 30_000) return auth
  if (!auth.refresh) throw new Error("missing refresh token")

  const response = await fetchTimeout(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new Error(`refresh HTTP ${response.status}`)

  const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!tokens.access_token) throw new Error("refresh missing access token")

  const next: Auth = {
    ...auth,
    access: tokens.access_token,
    refresh: tokens.refresh_token || auth.refresh,
    expires: Date.now() + (tokens.expires_in || 3600) * 1000,
  }
  next.accountId = auth.accountId || accountIDFromClaims(parseJwtClaims(next.access))
  tokenCache.set(providerID, next)
  return next
}

function setCookieHeaders(headers: Headers) {
  const getter = (headers as any).getSetCookie
  if (typeof getter === "function") return getter.call(headers) as string[]
  const raw = headers.get("set-cookie")
  if (!raw) return []
  return raw.split(/,(?=\s*(?:__cf|_cfuvid|cf_))/i)
}

function updateCloudflareCookies(jar: CookieJar, headers: Headers) {
  for (const header of setCookieHeaders(headers)) {
    const [pair] = header.split(";")
    const [name] = pair.split("=")
    const clean = name.trim()
    if (!clean || !(clean.startsWith("__cf") || clean.startsWith("cf_") || clean === "_cfuvid")) continue
    jar.cookies.set(clean, pair.trim())
  }
  if (jar.cookies.size) jar.expires = Date.now() + 25 * 60 * 1000
}

function cloudflareCookieHeader(jar: CookieJar) {
  if (!jar.cookies.size) return undefined
  return Array.from(jar.cookies.values()).join("; ")
}

async function ensureCloudflareCookie(jar: CookieJar, headers: Record<string, string>) {
  if (cloudflareCookieHeader(jar) && jar.expires > Date.now() + 30_000) return
  const response = await fetchTimeout(RESPONSES_URL, {
    method: "POST",
    headers,
    body: "{}",
  })
  updateCloudflareCookies(jar, response.headers)
}

function classify(seconds: number | undefined, fallback: "primary" | "secondary") {
  if (seconds && seconds >= 6 * 24 * 60 * 60) return "week"
  if (seconds && seconds >= 4 * 60 * 60 && seconds <= 6 * 60 * 60) return "5h"
  return fallback === "primary" ? "5h" : "week"
}

function normalizeWindow(raw: any, fallback: "primary" | "secondary"): WindowInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const used = Number(raw.used_percent)
  if (!Number.isFinite(used)) return undefined
  const seconds = Number(raw.limit_window_seconds)
  const resetAfter = Number(raw.reset_after_seconds)
  const resetAt = Number(raw.reset_at) || (Number.isFinite(resetAfter) ? Date.now() / 1000 + resetAfter : undefined)
  const label = classify(Number.isFinite(seconds) ? seconds : undefined, fallback)
  return {
    used,
    label,
    ...(Number.isFinite(seconds) ? { seconds } : {}),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
  }
}

function normalizeRateLimit(rateLimit: any) {
  const primary = normalizeWindow(rateLimit?.primary_window, "primary")
  const secondary = normalizeWindow(rateLimit?.secondary_window, "secondary")
  const windows = [primary, secondary].filter(Boolean) as WindowInfo[]
  return {
    fiveHour: windows.find((item) => item.label === "5h") || primary,
    week: windows.find((item) => item.label === "week") || secondary,
  }
}

async function fetchLimit(account: Account, authMap: Record<string, Auth>) {
  const auth = authMap[account.id]
  if (!auth) return { id: account.id, name: account.name, status: "missing", message: "not logged in" }
  if (auth.type !== "oauth") return { id: account.id, name: account.name, status: "unsupported", message: "not oauth" }

  try {
    const token = await refreshToken(account.id, auth)
    const accountId = accountIDFromTokens(token)
    if (!token.access || !accountId) throw new Error("missing account id")

    const headers = {
      authorization: `Bearer ${token.access}`,
      "ChatGPT-Account-Id": accountId,
      "Content-Type": "application/json",
      "User-Agent": "opencode",
    }
    const cookieJar: CookieJar = { cookies: new Map(), expires: 0 }
    await ensureCloudflareCookie(cookieJar, headers)

    const request = () =>
      fetchTimeout(USAGE_URL, {
        method: "GET",
        headers: {
          ...headers,
          ...(cloudflareCookieHeader(cookieJar) ? { cookie: cloudflareCookieHeader(cookieJar)! } : {}),
        },
      })

    let response = await request()
    updateCloudflareCookies(cookieJar, response.headers)
    if (response.status === 403) {
      cookieJar.cookies.clear()
      cookieJar.expires = 0
      await ensureCloudflareCookie(cookieJar, headers)
      response = await request()
      updateCloudflareCookies(cookieJar, response.headers)
    }
    if (!response.ok) throw new Error(`usage HTTP ${response.status}`)

    const data = (await response.json()) as any
    const windows = normalizeRateLimit(data?.rate_limit)
    return {
      id: account.id,
      name: account.name,
      status: "ok",
      plan: data?.plan_type,
      fiveHour: windows.fiveHour,
      week: windows.week,
      updatedAt: Date.now(),
    }
  } catch (err) {
    return {
      id: account.id,
      name: account.name,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    }
  }
}

function writeCache(snapshot: unknown) {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  const tmp = `${CACHE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8")
  renameSync(tmp, CACHE_FILE)
}

function readPreviousAccounts(accounts: Account[]) {
  try {
    const ids = new Set(accounts.map((account) => account.id))
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as { accounts?: any[] }
    if (!Array.isArray(cache.accounts)) return undefined
    const previous = cache.accounts.filter((account) => ids.has(String(account?.id || "")) && account?.message !== "refreshing")
    return previous.length ? previous : undefined
  } catch {
    return undefined
  }
}

function refreshingAccounts(now: number, accounts: Account[]) {
  const previous = readPreviousAccounts(accounts)
  const byId = new Map(previous?.map((account) => [account.id, account]))
  return accounts.map(
    (account) =>
      byId.get(account.id) || {
        id: account.id,
        name: account.name,
        status: "missing",
        message: "refreshing",
        updatedAt: now,
      },
  )
}

function writeErrorCache(message: string, accounts = discoverOpenAIAccounts()) {
  const now = Date.now()
  writeCache({
    updatedAt: now,
    error: message,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      status: "error",
      message,
      updatedAt: now,
    })),
  })
}

async function updateLimits() {
  const authMap = readAuthMap()
  const configuredAccounts = discoverOpenAIAccounts(authMap)
  const now = Date.now()
  writeCache({
    updatedAt: now,
    refreshing: true,
    accounts: refreshingAccounts(now, configuredAccounts),
  })
  const accounts = await Promise.all(configuredAccounts.map((account) => fetchLimit(account, authMap)))
  writeCache({ updatedAt: Date.now(), accounts })
}

function runUpdater() {
  if (running) {
    pending = true
    return
  }
  running = true
  void updateLimits()
    .catch((err) => writeErrorCache(err instanceof Error ? err.message : String(err)))
    .finally(() => {
      running = false
      if (pending) {
        pending = false
        runUpdater()
      }
    })
}

function pollRefreshRequest() {
  try {
    const mtime = statSync(REFRESH_REQUEST_FILE).mtimeMs
    if (mtime <= lastRefreshRequestMtime) return
    lastRefreshRequestMtime = mtime
    runUpdater()
  } catch {
    // No refresh request yet.
  }
}

function startWriter() {
  const state = globalThis as any
  if (state[STARTED_KEY]) return
  state[STARTED_KEY] = true
  runUpdater()
  setInterval(runUpdater, REFRESH_MS)
  setInterval(pollRefreshRequest, 1000)
}

startWriter()

export const OpenAILimitsWriterPlugin: Plugin = async () => {
  startWriter()
  return {}
}
