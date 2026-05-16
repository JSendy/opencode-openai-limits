import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  AUTH_FILE,
  CACHE_FILE,
  LEADER_FILE,
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
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const REFRESH_MS = 2 * 60 * 1000
const HTTP_TIMEOUT_MS = 12_000
const LEADER_HEARTBEAT_MS = 10_000
const LEADER_STALE_MS = 30_000
const CACHE_WRITE_RETRIES = 6
const CACHE_WRITE_RETRY_MS = 25

const tokenCache = new Map<string, Auth>()
const cookieJarCache = new Map<string, CookieJar>()
let running = false
let pending = false
let isLeader = false
let lastRefreshRequestMtime = 0
const STARTED_KEY = Symbol.for("opencode.openai-limits-writer.started")

type LeaderLease = {
  pid: number
  startedAt: number
  heartbeatAt: number
}

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

type PkceCodes = {
  verifier: string
  challenge: string
}

type PendingOAuth = {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function fetchTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function randomString(length: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length])
    .join("")
}

function base64Url(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = randomString(43)
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return { verifier, challenge: base64Url(hash) }
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetchTimeout(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) throw new Error(`token exchange HTTP ${response.status}`)
  return response.json()
}

async function startOAuthServer() {
  if (oauthServer) return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404)
      res.end("not found")
      return
    }

    const error = url.searchParams.get("error")
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (error || !code || !pendingOAuth || state !== pendingOAuth.state) {
      const message = error || (!code ? "missing authorization code" : "invalid oauth state")
      pendingOAuth?.reject(new Error(message))
      pendingOAuth = undefined
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end(`<h1>Authorization failed</h1><p>${message}</p>`)
      return
    }

    const current = pendingOAuth
    pendingOAuth = undefined
    exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
      .then(current.resolve)
      .catch(current.reject)
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end("<h1>Authorization successful</h1><p>You can close this window and return to OpenCode.</p>")
  })
  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, resolve)
    oauthServer!.on("error", reject)
  })
  return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  oauthServer?.close()
  oauthServer = undefined
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOAuth = undefined
      reject(new Error("OAuth callback timeout"))
    }, 5 * 60 * 1000)

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
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

function sameCredential(left: Auth | undefined, right: Auth) {
  return Boolean(left && left.type === "oauth" && (left.refresh === right.refresh || left.access === right.access))
}

function persistRefreshedAuth(providerID: string, previous: Auth, next: Auth) {
  if (previous.access === next.access && previous.refresh === next.refresh && previous.expires === next.expires && previous.accountId === next.accountId) return

  try {
    const authMap = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, Auth>
    const current = authMap[providerID]
    if (!sameCredential(current, previous)) return

    authMap[providerID] = {
      ...current,
      access: next.access,
      refresh: next.refresh,
      expires: next.expires,
      ...(next.accountId ? { accountId: next.accountId } : {}),
    }
    mkdirSync(dirname(AUTH_FILE), { recursive: true })
    writeFileSync(AUTH_FILE, `${JSON.stringify(authMap, null, 2)}\n`, "utf8")
  } catch {
    // Best effort; stale credentials will still work for the current process cache.
  }
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

async function fetchLimit(account: Account, authMap: Record<string, Auth>, onStep: (id: string, message: string) => void = () => {}) {
  const auth = authMap[account.id]
  if (!auth) return { id: account.id, name: account.name, status: "missing", message: "not logged in" }
  if (auth.type !== "oauth") return { id: account.id, name: account.name, status: "unsupported", message: "not oauth" }

  try {
    const token = await refreshToken(account.id, auth)
    persistRefreshedAuth(account.id, auth, token)
    const accountId = accountIDFromTokens(token)
    if (!token.access || !accountId) throw new Error("missing account id")

    const headers = {
      authorization: `Bearer ${token.access}`,
      "ChatGPT-Account-Id": accountId,
      "Content-Type": "application/json",
      "User-Agent": "opencode",
    }
    const cookieJar = cookieJarCache.get(account.id) ?? { cookies: new Map(), expires: 0 }
    cookieJarCache.set(account.id, cookieJar)
    await ensureCloudflareCookie(cookieJar, headers)

    const request = () =>
      fetchTimeout(USAGE_URL, {
        method: "GET",
        headers: {
          ...headers,
          ...(cloudflareCookieHeader(cookieJar) ? { cookie: cloudflareCookieHeader(cookieJar)! } : {}),
        },
      })

    onStep(account.id, "fetching usage")
    let response = await request()
    updateCloudflareCookies(cookieJar, response.headers)
    if (response.status === 403) {
      cookieJar.cookies.clear()
      cookieJar.expires = 0
      await ensureCloudflareCookie(cookieJar, headers)
      onStep(account.id, "fetching usage (retry)")
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
  const body = JSON.stringify(snapshot, null, 2)
  const tmp = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, body, "utf8")

  let lastError: unknown
  for (let attempt = 0; attempt < CACHE_WRITE_RETRIES; attempt++) {
    try {
      renameSync(tmp, CACHE_FILE)
      return
    } catch (err: any) {
      lastError = err
      if (process.platform !== "win32" || (err?.code !== "EPERM" && err?.code !== "EACCES")) break
      sleepSync(CACHE_WRITE_RETRY_MS * (attempt + 1))
    }
  }

  if (process.platform === "win32") {
    try {
      try {
        unlinkSync(CACHE_FILE)
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err
      }
      renameSync(tmp, CACHE_FILE)
      return
    } catch (err) {
      lastError = err
    }

    try {
      writeFileSync(CACHE_FILE, body, "utf8")
      try {
        unlinkSync(tmp)
      } catch {
        // Best effort cleanup only.
      }
      return
    } catch (err) {
      lastError = err
    }
  }

  try {
    unlinkSync(tmp)
  } catch {
    // Best effort cleanup only.
  }
  throw lastError
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function writeProgressCache(snapshot: unknown) {
  try {
    writeCache(snapshot)
  } catch {
    // Progress updates are best effort; the final snapshot carries the real result.
  }
}

function isProcessAlive(pid: number) {
  if (!pid || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

function readLeaderLease() {
  try {
    return JSON.parse(readFileSync(LEADER_FILE, "utf8")) as LeaderLease
  } catch {
    return undefined
  }
}

function writeLeaderLease(startedAt: number) {
  mkdirSync(dirname(LEADER_FILE), { recursive: true })
  writeFileSync(LEADER_FILE, JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: Date.now() }, null, 2), "utf8")
}

function createLeaderLease(startedAt: number) {
  mkdirSync(dirname(LEADER_FILE), { recursive: true })
  const fd = openSync(LEADER_FILE, "wx")
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: Date.now() }, null, 2), "utf8")
  } finally {
    closeSync(fd)
  }
}

function canTakeLeadership(lease: LeaderLease | undefined) {
  if (!lease) return true
  if (lease.pid === process.pid) return true
  if (!isProcessAlive(lease.pid)) return true
  return Date.now() - Number(lease.heartbeatAt || 0) > LEADER_STALE_MS
}

function tryBecomeLeader() {
  if (isLeader) return true
  const current = readLeaderLease()
  if (current && current.pid === process.pid) {
    isLeader = true
    writeLeaderLease(current.startedAt || Date.now())
    return true
  }
  if (!canTakeLeadership(current)) return false

  const startedAt = Date.now()
  try {
    if ((current && current.pid !== process.pid) || (!current && existsSync(LEADER_FILE))) unlinkSync(LEADER_FILE)
    createLeaderLease(startedAt)
    const next = readLeaderLease()
    isLeader = next?.pid === process.pid && next?.startedAt === startedAt
    return isLeader
  } catch {
    return false
  }
}

function refreshLeadership() {
  if (isLeader) {
    const current = readLeaderLease()
    if (!current || current.pid !== process.pid) {
      isLeader = false
      return false
    }
    writeLeaderLease(current.startedAt)
    return true
  }

  return tryBecomeLeader()
}

function releaseLeadership() {
  if (!isLeader) return
  isLeader = false
  try {
    const current = readLeaderLease()
    if (current?.pid === process.pid) unlinkSync(LEADER_FILE)
  } catch {
    // Best effort cleanup only.
  }
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
  const pendingAccounts = refreshingAccounts(now, configuredAccounts)
  writeProgressCache({ updatedAt: now, refreshing: true, accounts: pendingAccounts })

  const patchMessage = (accountId: string, message: string) => {
    for (const account of pendingAccounts) {
      if (account.id === accountId) account.message = message
    }
    writeProgressCache({ updatedAt: now, refreshing: true, accounts: pendingAccounts })
  }

  const accounts = await Promise.all(configuredAccounts.map((account) => fetchLimit(account, authMap, patchMessage)))
  writeCache({ updatedAt: Date.now(), accounts })
}

function runUpdater() {
  if (!isLeader) return
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
  if (!isLeader) return
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
  if (tryBecomeLeader()) runUpdater()
  setInterval(() => {
    refreshLeadership()
    runUpdater()
  }, REFRESH_MS)
  setInterval(() => {
    refreshLeadership()
    pollRefreshRequest()
  }, 1000)
  setInterval(refreshLeadership, LEADER_HEARTBEAT_MS)
  process.once("exit", releaseLeadership)
}

function removeAuthorization(headers: HeadersInit | undefined) {
  if (!headers) return headers
  if (headers instanceof Headers) {
    headers.delete("authorization")
    headers.delete("Authorization")
    return headers
  }
  if (Array.isArray(headers)) return headers.filter(([key]) => key.toLowerCase() !== "authorization")
  delete (headers as Record<string, string>)["authorization"]
  delete (headers as Record<string, string>)["Authorization"]
  return headers
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : ""
    })
    .filter(Boolean)
    .join("\n")
}

function withCodexInstructions(parsed: URL, init: RequestInit | undefined): RequestInit | undefined {
  if (!parsed.pathname.includes("/v1/responses") || typeof init?.body !== "string") return init

  try {
    const body = JSON.parse(init.body) as Record<string, any>
    if (body.instructions || !Array.isArray(body.input)) return init

    const instructions: string[] = []
    const input = []
    for (const item of body.input) {
      if (item?.role === "developer" || item?.role === "system") {
        const text = contentText(item.content)
        if (text) instructions.push(text)
        continue
      }
      input.push(item)
    }

    if (!instructions.length) return init
    return {
      ...init,
      body: JSON.stringify({
        ...body,
        instructions: instructions.join("\n\n"),
        input: input.length ? input : body.input,
      }),
    }
  } catch {
    return init
  }
}

function codexAuthHooks(input: Parameters<Plugin>[0], providerID: string) {
  return {
    auth: {
      provider: providerID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) init.headers = removeAuthorization(init.headers)
            const current = (await getAuth()) as Auth
            if (current.type !== "oauth") return fetch(requestInput, init)

            const token = await refreshToken(providerID, current)
            if (token !== current) {
              await input.client.auth.set({
                path: { id: providerID },
                body: {
                  type: "oauth",
                  refresh: token.refresh!,
                  access: token.access!,
                  expires: token.expires!,
                  ...(token.accountId ? { accountId: token.accountId } : {}),
                },
              })
            }

            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${token.access}`)
            if (token.accountId) headers.set("ChatGPT-Account-Id", token.accountId)

            const parsed = requestInput instanceof URL ? requestInput : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const nextInit = withCodexInstructions(parsed, init)
            const url = parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions") ? new URL(RESPONSES_URL) : parsed
            return fetch(url, { ...nextInit, headers })
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth" as const,
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer)
            const callbackPromise = waitForOAuthCallback(pkce, state)
            return {
              url: buildAuthorizeUrl(redirectUri, pkce, state),
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId: accountIDFromClaims(parseJwtClaims(tokens.id_token || tokens.access_token)),
                }
              },
            }
          },
        },
        { label: "Manually enter API Key", type: "api" as const },
      ],
    },
    "chat.headers": async (chatInput, output) => {
      if (chatInput.model.providerID !== providerID) return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = chatInput.sessionID
    },
    "chat.params": async (chatInput, output) => {
      if (chatInput.model.providerID !== providerID) return
      output.maxOutputTokens = undefined
    },
  } satisfies Awaited<ReturnType<Plugin>>
}

startWriter()

export const OpenAILimitsWriterPlugin: Plugin = async (input, options) => {
  startWriter()
  const providerID = typeof options?.providerID === "string" ? options.providerID : undefined
  return providerID ? codexAuthHooks(input, providerID) : {}
}
