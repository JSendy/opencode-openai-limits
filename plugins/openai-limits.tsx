/** @jsxImportSource @opentui/solid */
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import {
  AUTH_FILE,
  CACHE_FILE,
  DATA_DIR,
  OPENAI_LOGIN_METHOD,
  REFRESH_REQUEST_FILE,
  addOpenAIProvider,
  isSafeProviderID,
  removeOpenAIProvider,
  type WindowInfo,
} from "./openai-limits-shared.ts"

type AccountLimit = {
  id: string
  name: string
  status: "ok" | "missing" | "unsupported" | "error"
  plan?: string
  fiveHour?: WindowInfo
  week?: WindowInfo
  message?: string
  updatedAt?: number
}

type LimitsCache = {
  accounts?: AccountLimit[]
  updatedAt?: number
  error?: string
  refreshing?: boolean
}

type RefreshResult = {
  pending: boolean
  updatedAt: number
}

type Snapshot = {
  loading: boolean
  accounts: AccountLimit[]
  updatedAt?: number
}

type DisplayMode = "balanced" | "classic"

type DialogState =
  | { type: "limits" }
  | { type: "account"; accountID: string }
  | { type: "add-provider" }
  | { type: "login"; providerID: string; providerName: string; launched: boolean }
  | { type: "remove"; accountID: string }

const REFRESH_MS = 60 * 1000
const PENDING_STALE_MS = 90 * 1000
const SPINNER_MS = 100
const VIEW_FILE = join(DATA_DIR, "openai-limits-view.json")
const DISPLAY_MODES: DisplayMode[] = ["classic", "balanced"]

type Glyphs = {
  spinnerFrames: string[]
  refresh: string
  reset: string
  barFull: string
  barEmpty: string
  showBar: boolean
}

const FANCY_GLYPHS: Glyphs = {
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  refresh: "↻",
  reset: "⟳",
  barFull: "█",
  barEmpty: "░",
  showBar: true,
}

const WINDOWS_GLYPHS: Glyphs = {
  spinnerFrames: ["◐", "◓", "◑", "◒"],
  refresh: "↻",
  reset: "⟳",
  barFull: "█",
  barEmpty: "░",
  showBar: true,
}

const ASCII_GLYPHS: Glyphs = {
  spinnerFrames: ["o", "O", "0", "O"],
  refresh: "refresh",
  reset: "r",
  barFull: "#",
  barEmpty: "-",
  showBar: true,
}

const PLAIN_GLYPHS: Glyphs = {
  spinnerFrames: ["-", "\\", "|", "/"],
  refresh: "refresh",
  reset: "r",
  barFull: "",
  barEmpty: "",
  showBar: false,
}

function glyphs() {
  const style = String(process.env.OPENCODE_LIMITS_STYLE || "").toLowerCase()
  if (style === "ascii") return ASCII_GLYPHS
  if (style === "plain") return PLAIN_GLYPHS
  if (style === "unicode" || style === "fancy") return FANCY_GLYPHS
  return process.platform === "win32" ? WINDOWS_GLYPHS : FANCY_GLYPHS
}

const GLYPHS = glyphs()
const SPINNER_FRAMES = GLYPHS.spinnerFrames

const initialAccounts: AccountLimit[] = [
  {
    id: "openai",
    name: "OpenAI",
    status: "missing",
    message: "loading",
  },
]

const [snapshot, setSnapshot] = createSignal<Snapshot>({
  loading: true,
  accounts: initialAccounts,
})

const [lastError, setLastError] = createSignal<string | undefined>(undefined)
const [displayMode, setDisplayModeSignal] = createSignal<DisplayMode>(readDisplayMode())

const [spinnerFrame, setSpinnerFrame] = createSignal(0)
let spinnerTimer: ReturnType<typeof setInterval> | undefined

function startSpinner() {
  if (spinnerTimer) return
  spinnerTimer = setInterval(() => {
    setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    requestRender()
  }, SPINNER_MS)
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = undefined
  }
}

let cacheWatcher: ReturnType<typeof watch> | undefined
let currentApi: TuiPluginApi | undefined
let dialogApi: TuiPluginApi | undefined
let activeDialog: DialogState | undefined
let viewWriteTimer: ReturnType<typeof setTimeout> | undefined

function requestRender() {
  currentApi?.renderer.requestRender()
}

function hasPendingMarker(cache: LimitsCache) {
  return Boolean(cache.refreshing || cache.accounts?.some((account) => account.message === "refreshing"))
}

function isPendingCache(cache: LimitsCache) {
  return hasPendingMarker(cache) && Date.now() - (cache.updatedAt || 0) < PENDING_STALE_MS
}

function applyCache(cache: LimitsCache): RefreshResult {
  const updatedAt = cache.updatedAt || Date.now()
  const pending = isPendingCache(cache)
  const accounts = pending
    ? cache.accounts!
    : cache.accounts!.map((account) => (account.message === "refreshing" ? { ...account, message: "refresh timed out" } : account))
  const errorAccount = !pending && accounts.find((a) => a.status === "error")
  if (errorAccount) setLastError(`${errorAccount.name}: ${errorAccount.message}`)
  else if (!pending) setLastError(undefined)
  setSnapshot({ loading: pending, accounts, updatedAt })
  if (pending) startSpinner()
  else stopSpinner()
  requestRender()
  rerenderDialog()
  return { pending, updatedAt }
}

function readCache(): LimitsCache | undefined {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as LimitsCache
    if (!Array.isArray(cache.accounts)) return undefined
    return cache
  } catch {
    return undefined
  }
}

function refreshLimits() {
  const cache = readCache()
  if (!cache) return
  // Ignore a completed cache that is older than what we already have
  if (!isPendingCache(cache) && (cache.updatedAt ?? 0) < (snapshot().updatedAt ?? 0)) return
  applyCache(cache)
}

function isDisplayMode(value: string): value is DisplayMode {
  return DISPLAY_MODES.includes(value as DisplayMode)
}

function readDisplayMode(): DisplayMode {
  try {
    const value = JSON.parse(readFileSync(VIEW_FILE, "utf8"))?.mode
    return typeof value === "string" && isDisplayMode(value) ? value : "classic"
  } catch {
    return "classic"
  }
}

function selectDisplayMode(mode: DisplayMode) {
  if (displayMode() === mode) return
  setDisplayModeSignal(mode)
  if (viewWriteTimer) clearTimeout(viewWriteTimer)
  viewWriteTimer = setTimeout(() => writeDisplayMode(mode), 50)
  requestRender()
  setTimeout(() => requestRender(), 0)
}

function writeDisplayMode(mode: DisplayMode) {
  viewWriteTimer = undefined
  try {
    mkdirSync(dirname(VIEW_FILE), { recursive: true })
    writeFileSync(VIEW_FILE, JSON.stringify({ mode }, null, 2), "utf8")
  } catch {
    // Non-fatal; the current session still switches immediately.
  }
}

function startCacheWatcher() {
  if (cacheWatcher) return
  try {
    const cacheFilename = basename(CACHE_FILE)
    let debounce: ReturnType<typeof setTimeout> | undefined
    cacheWatcher = watch(DATA_DIR, (_, filename) => {
      if (filename !== cacheFilename) return
      clearTimeout(debounce)
      debounce = setTimeout(() => refreshLimits(), 20)
    })
  } catch {
    // DATA_DIR doesn't exist yet; fallback timer will handle it.
  }
}

function requestRefresh(api: TuiPluginApi) {
  try {
    mkdirSync(dirname(REFRESH_REQUEST_FILE), { recursive: true })
    writeFileSync(REFRESH_REQUEST_FILE, JSON.stringify({ requestedAt: Date.now() }), "utf8")
    setSnapshot((current) => ({ ...current, loading: true }))
    startSpinner()
    requestRender()
    rerenderDialog()
    api.ui.toast({ variant: "info", title: "OpenAI limits", message: "refresh requested", duration: 1500 })
  } catch (err) {
    api.ui.toast({
      variant: "error",
      title: "OpenAI limits",
      message: err instanceof Error ? err.message : String(err),
      duration: 3000,
    })
  }
}

function pct(value?: WindowInfo) {
  if (!value) return "?%"
  return `${Math.max(0, Math.min(100, Math.round(100 - value.used)))}%`
}

function minutesUntil(value?: WindowInfo) {
  if (!value?.resetAt) return undefined
  return Math.max(0, Math.round((value.resetAt * 1000 - Date.now()) / 60_000))
}

function duration(mins: number) {
  if (mins <= 0) return "0h"
  if (mins < 60) return "<1h"
  return `${Math.ceil(mins / 60)}h`
}

function resetLeft(value?: WindowInfo) {
  const mins = minutesUntil(value)
  return mins === undefined ? "?" : duration(mins)
}

function reset(value?: WindowInfo) {
  if (!value?.resetAt) return `${GLYPHS.reset} ?`
  const ms = value.resetAt * 1000
  const date = new Date(ms)
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const at = `${day} ${time}`
  return `${GLYPHS.reset} ${resetLeft(value)} ${at}`
}

function resetShort(value?: WindowInfo) {
  return `${GLYPHS.reset} ${resetLeft(value)}`
}

function resetBare(value?: WindowInfo) {
  return resetLeft(value)
}

function resetLong(value?: WindowInfo) {
  if (!value?.resetAt) return "refreshes at unknown time"
  const ms = value.resetAt * 1000
  const date = new Date(ms)
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return `refreshes in ${resetLeft(value)} on ${day}, ${month} ${date.getDate()}, ${time}`
}

function updated(value?: number) {
  if (!value) return "no data"
  const mins = Math.max(0, Math.round((Date.now() - value) / 60_000))
  return mins < 1 ? "just now" : `${mins}m ago`
}

function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}~`
}

function shortName(account: AccountLimit) {
  const match = account.id.match(/^openai-account-(\d+)$/)
  if (match) return `A${match[1]}`
  if (account.id === "openai") return "AI"
  return clip(account.name, 14)
}

function line(account: AccountLimit, compact = false) {
  const name = compact ? shortName(account) : account.name
  if (account.status !== "ok") return `${name}: ${account.message || account.status}`
  if (compact) return `${name}: ${pct(account.fiveHour)} ${resetShort(account.fiveHour)} wk ${pct(account.week)} ${resetShort(account.week)}`
  return `${name}: ${pct(account.fiveHour)} remaining ${reset(account.fiveHour)} week ${pct(account.week)} remaining ${reset(account.week)}`
}

function bar(value: WindowInfo | undefined, width: number) {
  if (!GLYPHS.showBar) return ""
  const remaining = value ? Math.max(0, Math.min(100, Math.round(100 - value.used))) : 0
  const filled = Math.round((remaining / 100) * width)
  return GLYPHS.barFull.repeat(filled) + GLYPHS.barEmpty.repeat(width - filled)
}

function barPart(value: WindowInfo | undefined, width: number) {
  const text = bar(value, width)
  return text ? ` ${text}` : ""
}

function balancedLines(account: AccountLimit, name: string) {
  return [`${name}: ${pct(account.fiveHour)} ${resetBare(account.fiveHour)} wk ${pct(account.week)} ${resetBare(account.week)}`]
}

function classicLines(account: AccountLimit, name: string, pad: string, width: number) {
  return [
    `${name} 5h${barPart(account.fiveHour, width)} ${pct(account.fiveHour)} ${resetShort(account.fiveHour)}`,
    `${pad} wk${barPart(account.week, width)} ${pct(account.week)} ${resetShort(account.week)}`,
  ]
}

function displayLines(account: AccountLimit, name: string, pad: string, width: number) {
  const mode = displayMode()
  if (mode === "classic") return classicLines(account, name, pad, width)
  return balancedLines(account, name)
}

function pairs<T>(items: T[]) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += 2) result.push(items.slice(index, index + 2))
  return result
}

function tone(api: TuiPluginApi) {
  return {
    panel: api.theme.current.backgroundPanel,
    border: api.theme.current.border,
    text: api.theme.current.text,
    muted: api.theme.current.textMuted,
    accent: api.theme.current.primary,
    warn: api.theme.current.warning,
    error: api.theme.current.error,
    ok: api.theme.current.success,
  }
}

function color(api: TuiPluginApi, account: AccountLimit) {
  const skin = tone(api)
  if (account.status === "error") return skin.error
  if (account.status !== "ok") return skin.muted
  const max = Math.max(account.fiveHour?.used ?? 0, account.week?.used ?? 0)
  if (max >= 90) return skin.error
  if (max >= 75) return skin.warn
  return skin.ok
}

function loginArgs() {
  return ["--pure", "auth", "login", "--provider", "openai", "--method", OPENAI_LOGIN_METHOD]
}

function quoteArg(value: string) {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) return value
  return `"${value.replace(/(["\\])/g, "\\$1")}"`
}

function loginCommand() {
  return ["opencode", ...loginArgs()].map(quoteArg).join(" ")
}

function cmdArg(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function shellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function loginRunnerScript() {
  const file = join(DATA_DIR, "openai-limits-login-runner.cjs")
  writeFileSync(
    file,
    `const { spawn, spawnSync } = require("node:child_process")
const [, , tempData] = process.argv
if (!tempData) throw new Error("missing temp data path")

const args = ["--pure", "auth", "login", "--provider", "openai", "--method", ${JSON.stringify(OPENAI_LOGIN_METHOD)}]
const env = { ...process.env, XDG_DATA_HOME: tempData }
let opened = false
let buffer = ""

function openURL(url) {
  if (process.platform === "win32") return spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref()
  if (process.platform === "darwin") return spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
  return spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
}

function spawnOpencode() {
  if (process.platform !== "win32") return spawn("opencode", args, { env, shell: false })
  const found = spawnSync("where.exe", ["opencode.cmd"], { encoding: "utf8" })
  const exe = String(found.stdout || "").replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10)).find(Boolean) || "opencode.cmd"
  return spawn("cmd.exe", ["/d", "/c", "call", exe, ...args], { env, shell: false })
}

function scan(data) {
  const text = String(data)
  process.stdout.write(data)
  buffer = (buffer + text).slice(-8000)
  if (opened) return
  const marker = "https://auth.openai.com/oauth/authorize?"
  const start = buffer.indexOf(marker)
  if (start === -1) return
  let end = buffer.length
  for (let index = start; index < buffer.length; index++) {
    const code = buffer.charCodeAt(index)
    if (code <= 32 || code === 0x1b) {
      end = index
      break
    }
  }
  const url = buffer.slice(start, end)
  opened = true
  try { openURL(url) } catch {}
}

const child = spawnOpencode()
child.stdout.on("data", scan)
child.stderr.on("data", scan)
child.on("error", (err) => {
  console.error(err.message)
  process.exit(1)
})
child.on("exit", (code) => process.exit(typeof code === "number" ? code : 1))
`,
    "utf8",
  )
  return file
}

function loginCopyScript() {
  const file = join(DATA_DIR, "openai-limits-copy-auth.cjs")
  writeFileSync(
    file,
    `const fs = require("node:fs")
const path = require("node:path")
const [, , sourceFile, targetFile, providerID, refreshFile] = process.argv
if (!sourceFile || !targetFile || !providerID) throw new Error("missing args")
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"))
const credential = source.openai
if (!credential) throw new Error("browser login did not create OpenAI credential")
let target = {}
try { target = JSON.parse(fs.readFileSync(targetFile, "utf8")) } catch {}
target[providerID] = credential
fs.mkdirSync(path.dirname(targetFile), { recursive: true })
fs.writeFileSync(targetFile, JSON.stringify(target, null, 2) + "\\n", "utf8")
if (refreshFile) {
  fs.mkdirSync(path.dirname(refreshFile), { recursive: true })
  fs.writeFileSync(refreshFile, JSON.stringify({ requestedAt: Date.now() }), "utf8")
}
console.log("Saved OpenAI credential for " + providerID)
`,
    "utf8",
  )
  return file
}

function safeFolderName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function launchLogin(providerID: string) {
  if (!isSafeProviderID(providerID)) return false
  try {
    if (process.platform === "win32") {
      mkdirSync(DATA_DIR, { recursive: true })
      const runnerScript = loginRunnerScript()
      const copyScript = loginCopyScript()
      const tempData = join(tmpdir(), "opencode", "openai-limits-login", safeFolderName(providerID))
      const tempAuth = join(tempData, "opencode", "auth.json")
      const script = join(DATA_DIR, "openai-limits-login.cmd")
      writeFileSync(
        script,
        [
          "@echo off",
          `title OpenCode OpenAI Login - ${providerID}`,
          `echo OpenCode OpenAI login for ${providerID}`,
          `if exist ${cmdArg(tempData)} rmdir /s /q ${cmdArg(tempData)}`,
          ["node", runnerScript, tempData].map(cmdArg).join(" "),
          "if errorlevel 1 goto failed",
          ["node", copyScript, tempAuth, AUTH_FILE, providerID, REFRESH_REQUEST_FILE].map(cmdArg).join(" "),
          "if errorlevel 1 goto failed",
          `rmdir /s /q ${cmdArg(tempData)} 2>nul`,
          "echo.",
          "echo Login complete. You can close this window.",
          "pause",
          "exit /b 0",
          ":failed",
          "echo.",
          "echo Login failed. Keep this window open and retry from OpenCode.",
          "pause",
          "exit /b 1",
          "",
        ].join("\r\n"),
        "utf8",
      )
      const child = spawn("cmd.exe", ["/c", "start", "", script], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      })
      child.unref()
      return true
    }

    if (process.platform === "darwin") {
      mkdirSync(DATA_DIR, { recursive: true })
      const runnerScript = loginRunnerScript()
      const copyScript = loginCopyScript()
      const tempData = join(tmpdir(), "opencode", "openai-limits-login", safeFolderName(providerID))
      const tempAuth = join(tempData, "opencode", "auth.json")
      const script = join(DATA_DIR, "openai-limits-login.sh")
      writeFileSync(
        script,
        [
          "#!/bin/sh",
          "set -u",
          `echo ${shellArg(`OpenCode OpenAI login for ${providerID}`)}`,
          `rm -rf -- ${shellArg(tempData)}`,
          ["node", runnerScript, tempData].map(shellArg).join(" "),
          "if [ $? -ne 0 ]; then",
          "  echo",
          `  echo ${shellArg("Login failed. Keep this window open and retry from OpenCode.")}`,
          `  printf ${shellArg("Press enter to close...")}`,
          "  read _unused",
          "  exit 1",
          "fi",
          ["node", copyScript, tempAuth, AUTH_FILE, providerID, REFRESH_REQUEST_FILE].map(shellArg).join(" "),
          "if [ $? -ne 0 ]; then",
          "  echo",
          `  echo ${shellArg("Login failed. Keep this window open and retry from OpenCode.")}`,
          `  printf ${shellArg("Press enter to close...")}`,
          "  read _unused",
          "  exit 1",
          "fi",
          `rm -rf -- ${shellArg(tempData)}`,
          "echo",
          `echo ${shellArg("Login complete. You can close this window.")}`,
          `printf ${shellArg("Press enter to close...")}`,
          "read _unused",
          "",
        ].join("\n"),
        "utf8",
      )
      chmodSync(script, 0o700)
      const command = ["sh", script].map(shellArg).join(" ")
      const child = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      return true
    }
  } catch {
    return false
  }
  return false
}

function startProviderLogin(api: TuiPluginApi, providerID: string, providerName: string) {
  const launched = launchLogin(providerID)
  activeDialog = { type: "login", providerID, providerName, launched }
  dialogApi = api
  renderActiveDialog(api)
  api.ui.toast({
    variant: launched ? "success" : "info",
    title: "OpenAI login",
    message: launched ? "login terminal opened" : "run login command manually",
    duration: 2500,
  })
}

function findAccount(accountID: string) {
  return snapshot().accounts.find((account) => account.id === accountID) || { id: accountID, name: accountID, status: "missing" as const, message: "not loaded" }
}

function canRemoveProvider(account: AccountLimit) {
  return account.id !== "openai"
}

const ActionButton = (props: { api: TuiPluginApi; label: string; primary?: boolean; onClick: () => void }) => {
  const skin = tone(props.api)
  return (
    <box backgroundColor={props.primary ? skin.accent : skin.border} paddingLeft={1} paddingRight={1} onMouseUp={props.onClick}>
      <text fg={skin.text}>{props.label}</text>
    </box>
  )
}

const ViewButton = (props: { api: TuiPluginApi; mode: DisplayMode }) => {
  const skin = tone(props.api)
  const active = () => displayMode() === props.mode
  return (
    <box backgroundColor={active() ? skin.accent : skin.border} paddingLeft={1} paddingRight={1} onMouseUp={() => selectDisplayMode(props.mode)}>
      <text fg={skin.text}>{active() ? `[${props.mode}]` : props.mode}</text>
    </box>
  )
}

const ViewModePicker = (props: { api: TuiPluginApi }) => {
  const skin = tone(props.api)
  return (
    <box flexDirection="row" gap={1}>
      <text fg={skin.muted}>view</text>
      {DISPLAY_MODES.map((mode) => <ViewButton api={props.api} mode={mode} />)}
    </box>
  )
}

const BarRow = (props: { api: TuiPluginApi; account: AccountLimit; barWidth: number }) => {
  const skin = tone(props.api)
  const account = props.account
  const clr = color(props.api, account)
  const name = shortName(account)
  const pad = " ".repeat(name.length)

  if (account.status !== "ok") {
    return (
      <box onMouseUp={() => openAccountDialog(props.api, account)}>
        <text fg={skin.muted}>{name}: {account.message || account.status}</text>
      </box>
    )
  }

  const w = props.barWidth
  return (
    <box flexDirection="column" gap={0} onMouseUp={() => openAccountDialog(props.api, account)}>
      {displayLines(account, name, pad, w).map((text) => <text fg={clr} wrap={false}>{text}</text>)}
    </box>
  )
}

const ViewPreview = (props: { api: TuiPluginApi; account: AccountLimit }) => {
  const skin = tone(props.api)
  const account = props.account
  if (account.status !== "ok") return null
  const name = shortName(account)
  const pad = " ".repeat(name.length)
  const width = 12
  return (
    <box flexDirection="column" gap={0}>
      <text fg={skin.muted}>preview</text>
      {displayLines(account, name, pad, width).map((text) => <text fg={color(props.api, account)} wrap={false}>{text}</text>)}
    </box>
  )
}

const ClassicAccountDivider = (props: { api: TuiPluginApi }) => {
  const skin = tone(props.api)
  return (
    <box flexDirection="column" gap={0} width={1} flexGrow={0} flexShrink={0}>
      <text fg={skin.border} wrap={false}>│</text>
      <text fg={skin.border} wrap={false}>│</text>
    </box>
  )
}

const ClassicAccountSpacer = () => <box height={1} flexGrow={0} flexShrink={0} />

const LimitsList = (props: { api: TuiPluginApi; compact?: boolean; controls?: boolean; grid?: boolean }) => {
  const skin = tone(props.api)
  const data = () => snapshot()
  const barWidth = props.grid ? 16 : 12

  const accountBox = (account: AccountLimit) => (
    <box width={props.grid && displayMode() !== "classic" ? 50 : "auto"} flexGrow={0} flexShrink={0}>
      <BarRow api={props.api} account={account} barWidth={barWidth} />
    </box>
  )

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={skin.accent} wrap={false}><b>OpenAI limits remaining</b></text>
        <box onMouseUp={() => !data().loading && requestRefresh(props.api)}>
          <text fg={skin.muted} wrap={false}>{data().loading ? `${SPINNER_FRAMES[spinnerFrame()]} ${data().accounts.map(a => shortName(a)).join(", ")} refreshing` : `${GLYPHS.refresh} ${updated(data().updatedAt)}`}</text>
        </box>
      </box>
      {props.controls
        ? <ViewModePicker api={props.api} />
        : null}
      {data().accounts.length === 0 ? <text fg={skin.muted}>No OpenAI providers found</text> : null}
      {props.grid
        ? pairs<AccountLimit>(data().accounts).map((row) => (
            <box flexDirection="row" gap={displayMode() === "classic" ? 0 : 2}>
              {row.map((account, index) => (
                <box flexDirection="row" gap={displayMode() === "classic" ? 1 : 0}>
                  {index > 0 && displayMode() === "classic" ? <ClassicAccountDivider api={props.api} /> : null}
                  {accountBox(account)}
                </box>
              ))}
            </box>
          ))
        : data().accounts.map((account, index) => (
            <box flexDirection="column" gap={0}>
              {props.compact && displayMode() === "classic" && index > 0 ? <ClassicAccountSpacer /> : null}
              {accountBox(account)}
            </box>
          ))}
      {lastError() ? <text fg={skin.error} wrap={false}>{lastError()}</text> : null}
    </box>
  )
}



function slots(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 900,
    slots: {
      home_bottom() {
        const skin = tone(api)
        return (
          <box width="100%" maxWidth={118} paddingTop={1} flexShrink={0}>
            <box border borderColor={skin.border} backgroundColor={skin.panel} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
              <LimitsList api={api} compact />
            </box>
          </box>
        )
      },
      sidebar_footer() {
        const skin = tone(api)
        return (
          <box border borderColor={skin.border} backgroundColor={skin.panel} paddingLeft={1} paddingRight={1}>
            <LimitsList api={api} compact />
          </box>
        )
      },
      sidebar_content() {
        const skin = tone(api)
        return (
          <box paddingTop={1} paddingBottom={1} flexDirection="column">
            <box border borderColor={skin.border} backgroundColor={skin.panel} paddingLeft={1} paddingRight={1}>
              <LimitsList api={api} compact />
            </box>
          </box>
        )
      },
    },
  }
}

function rerenderDialog() {
  if (dialogApi?.ui.dialog.open) renderActiveDialog(dialogApi)
}

function closeDialog(api: TuiPluginApi) {
  if (dialogApi === api) dialogApi = undefined
  activeDialog = undefined
  api.ui.dialog.clear()
}

function renderLimitsDialog(api: TuiPluginApi) {
  const Dialog = api.ui.Dialog
  const skin = tone(api)
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => (
    <Dialog onClose={() => closeDialog(api)}>
      <box paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
        <LimitsList api={api} controls />
        <box flexDirection="row" gap={1}>
          <ActionButton api={api} label="close" onClick={() => closeDialog(api)} />
        </box>
        <text fg={skin.muted}>Click provider to login again.</text>
      </box>
    </Dialog>
  ))
}

function renderAccountDialog(api: TuiPluginApi, account: AccountLimit) {
  const Dialog = api.ui.Dialog
  const skin = tone(api)
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => (
    <Dialog onClose={() => closeDialog(api)}>
      <box paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
        <box flexDirection="row" gap={1}>
          <text fg={skin.accent}><b>{account.name}</b></text>
          <text fg={skin.muted}>({account.id}{account.plan ? ` / ${account.plan}` : ""})</text>
        </box>
        {account.status !== "ok"
          ? <text fg={color(api, account)}>{account.message || account.status}</text>
          : <box flexDirection="column" gap={0}>
              <text fg={color(api, account)} wrap={false}>{`primary ${pct(account.fiveHour)} remaining - ${resetLong(account.fiveHour)}`}</text>
              <text fg={color(api, account)} wrap={false}>{`week ${pct(account.week)} remaining - ${resetLong(account.week)}`}</text>
            </box>
        }

        <ViewModePicker api={api} />
        <ViewPreview api={api} account={account} />

        <box flexDirection="row" gap={1}>
          <ActionButton api={api} label={account.status === "missing" ? "login" : "relogin"} primary onClick={() => startProviderLogin(api, account.id, account.name)} />
          {canRemoveProvider(account) ? <ActionButton api={api} label="remove" onClick={() => openRemoveProviderDialog(api, account)} /> : null}
          <ActionButton api={api} label="add provider" onClick={() => openAddProviderDialog(api)} />
          <ActionButton api={api} label="close" onClick={() => closeDialog(api)} />
        </box>
      </box>
    </Dialog>
  ))
}

function renderRemoveProviderDialog(api: TuiPluginApi, account: AccountLimit) {
  const DialogConfirm = api.ui.DialogConfirm
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogConfirm
      title="Remove OpenAI provider"
      message={`Remove ${account.name}? This deletes its provider config and local credential.`}
      onConfirm={() => {
        try {
          removeOpenAIProvider(account.id)
          setSnapshot((current) => ({
            ...current,
            accounts: current.accounts.filter((item) => item.id !== account.id),
            updatedAt: Date.now(),
          }))
          requestRender()
          api.ui.toast({ variant: "success", title: "OpenAI provider removed", message: account.name, duration: 2500 })
          openDialog(api)
        } catch (err) {
          api.ui.toast({ variant: "error", title: "Remove OpenAI provider", message: err instanceof Error ? err.message : String(err), duration: 3500 })
          openAccountDialog(api, account)
        }
      }}
      onCancel={() => openAccountDialog(api, account)}
    />
  ))
}

function renderLoginDialog(api: TuiPluginApi, state: Extract<DialogState, { type: "login" }>) {
  const Dialog = api.ui.Dialog
  const skin = tone(api)
  const command = loginCommand()
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => (
    <Dialog onClose={() => closeDialog(api)}>
      <box paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
        <text fg={skin.accent}>
          <b>OpenAI login</b>
        </text>
        <text>{state.providerName}</text>
        <text fg={state.launched ? skin.ok : skin.warn}>{state.launched ? "Login terminal opened. Finish browser auth, then refresh." : "Run command manually, finish browser auth, then refresh."}</text>
        <text fg={skin.muted}>Browser auth uses built-in OpenAI, then saves credential as {state.providerID}.</text>
        <text fg={skin.warn}>Restart OpenCode after adding a provider before using it as a model. Refresh only updates limits.</text>
        <text fg={skin.muted}>{command}</text>
        <box flexDirection="row" gap={1}>
          <ActionButton api={api} label="close" onClick={() => closeDialog(api)} />
        </box>
      </box>
    </Dialog>
  ))
}

function renderAddProviderDialog(api: TuiPluginApi) {
  const DialogPrompt = api.ui.DialogPrompt
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogPrompt
      title="Add OpenAI provider"
      placeholder="A7 or work"
      description={() => <text>Creates the next openai-account provider and opens browser login. Restart OpenCode before model use.</text>}
      onConfirm={(value) => {
        try {
          const provider = addOpenAIProvider(value)
          api.ui.toast({ variant: "info", title: "OpenAI provider added", message: "Finish login, then restart OpenCode before model use.", duration: 4500 })
          startProviderLogin(api, provider.id, provider.name)
          requestRefresh(api)
        } catch (err) {
          api.ui.toast({ variant: "error", title: "Add OpenAI provider", message: err instanceof Error ? err.message : String(err), duration: 3500 })
          openAddProviderDialog(api)
        }
      }}
      onCancel={() => closeDialog(api)}
    />
  ))
}

function renderActiveDialog(api: TuiPluginApi) {
  if (!activeDialog) return
  if (activeDialog.type === "limits") return renderLimitsDialog(api)
  if (activeDialog.type === "account") return renderAccountDialog(api, findAccount(activeDialog.accountID))
  if (activeDialog.type === "add-provider") return renderAddProviderDialog(api)
  if (activeDialog.type === "remove") return renderRemoveProviderDialog(api, findAccount(activeDialog.accountID))
  return renderLoginDialog(api, activeDialog)
}

function openDialog(api: TuiPluginApi) {
  dialogApi = api
  activeDialog = { type: "limits" }
  renderActiveDialog(api)
}

function openAccountDialog(api: TuiPluginApi, account: AccountLimit) {
  dialogApi = api
  activeDialog = { type: "account", accountID: account.id }
  renderActiveDialog(api)
}

function openRemoveProviderDialog(api: TuiPluginApi, account: AccountLimit) {
  dialogApi = api
  activeDialog = { type: "remove", accountID: account.id }
  renderActiveDialog(api)
}

function openAddProviderDialog(api: TuiPluginApi) {
  dialogApi = api
  activeDialog = { type: "add-provider" }
  renderActiveDialog(api)
}

const tui: TuiPlugin = async (api) => {
  currentApi = api
  startCacheWatcher()
  void refreshLimits()
  const fallbackTimer = setInterval(() => void refreshLimits(), REFRESH_MS)
  api.lifecycle.onDispose(() => {
    clearInterval(fallbackTimer)
    cacheWatcher?.close()
    cacheWatcher = undefined
    stopSpinner()
    if (viewWriteTimer) {
      clearTimeout(viewWriteTimer)
      viewWriteTimer = undefined
    }
    if (currentApi === api) currentApi = undefined
    if (dialogApi === api) dialogApi = undefined
  })
  api.slots.register(slots(api))
  api.command.register(() => [
    {
      title: "OpenAI limits",
      value: "plugin.openai-limits.show",
      category: "Plugin",
      slash: { name: "limits", aliases: ["openai-limits"] },
      onSelect: () => openDialog(api),
    },
    {
      title: "Refresh OpenAI limits now",
      value: "plugin.openai-limits.refresh",
      category: "Plugin",
      slash: { name: "limits-refresh" },
      onSelect: () => {
        requestRefresh(api)
      },
    },
    {
      title: "Add OpenAI provider",
      value: "plugin.openai-limits.add-provider",
      category: "Plugin",
      slash: { name: "limits-add" },
      onSelect: () => openAddProviderDialog(api),
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "openai-limits",
  tui,
}

export default plugin
