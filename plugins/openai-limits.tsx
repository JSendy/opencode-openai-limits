/** @jsxImportSource @opentui/solid */
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

type DialogState =
  | { type: "limits" }
  | { type: "account"; accountID: string }
  | { type: "add-provider" }
  | { type: "login"; providerID: string; providerName: string; launched: boolean }
  | { type: "remove"; accountID: string }

const REFRESH_MS = 2 * 60 * 1000
const REFRESH_WAIT_MS = 90 * 1000
const PENDING_STALE_MS = 90 * 1000

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

let refreshing = false
let refreshPollTimer: ReturnType<typeof setTimeout> | undefined
let currentApi: TuiPluginApi | undefined
let dialogApi: TuiPluginApi | undefined
let activeDialog: DialogState | undefined

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
  setSnapshot({ loading: pending, accounts, updatedAt })
  requestRender()
  rerenderDialog()
  return { pending, updatedAt }
}

function readCache() {
  const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as LimitsCache
  if (cache.error) throw new Error(cache.error)
  if (!Array.isArray(cache.accounts)) throw new Error("limits cache missing accounts")
  return cache
}

async function refreshLimits(): Promise<RefreshResult> {
  if (refreshing) return { pending: true, updatedAt: snapshot().updatedAt ?? 0 }
  refreshing = true
  try {
    setSnapshot((current) => ({
      ...current,
      loading: true,
      accounts: current.accounts.length ? current.accounts : initialAccounts,
    }))
    const cache = readCache()
    return applyCache(cache)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const accounts = snapshot().accounts.length ? snapshot().accounts : initialAccounts
    setSnapshot({
      loading: false,
      accounts: accounts.map((account) => ({
        ...account,
        status: "error" as const,
        message,
      })),
      updatedAt: snapshot().updatedAt,
    })
    requestRender()
    rerenderDialog()
    return { pending: true, updatedAt: snapshot().updatedAt ?? 0 }
  } finally {
    refreshing = false
  }
}

function pollForUpdatedCache(since: number, deadline: number) {
  clearTimeout(refreshPollTimer)
  refreshPollTimer = setTimeout(() => {
    void refreshLimits().then((result) => {
      if ((result.pending || result.updatedAt <= since) && Date.now() < deadline) pollForUpdatedCache(since, deadline)
    })
  }, 1000)
}

function requestRefresh(api: TuiPluginApi) {
  const since = snapshot().updatedAt ?? 0
  try {
    mkdirSync(dirname(REFRESH_REQUEST_FILE), { recursive: true })
    writeFileSync(REFRESH_REQUEST_FILE, JSON.stringify({ requestedAt: Date.now() }), "utf8")
    setSnapshot((current) => ({ ...current, loading: true }))
    requestRender()
    rerenderDialog()
    pollForUpdatedCache(since, Date.now() + REFRESH_WAIT_MS)
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
  if (!value?.resetAt) return "r ?"
  const ms = value.resetAt * 1000
  const at = new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
  return `r ${resetLeft(value)} ${at}`
}

function resetShort(value?: WindowInfo) {
  return `r ${resetLeft(value)}`
}

function updated(value?: number) {
  if (!value) return "no data"
  const mins = Math.max(0, Math.round((Date.now() - value) / 60_000))
  return mins < 1 ? "upd now" : `upd ${mins}m ago`
}

function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}~`
}

function shortName(account: AccountLimit) {
  const match = account.id.match(/^openai-account-(\d+)$/)
  if (match) return `A${match[1]}`
  if (account.id === "openai") return "OpenAI"
  return clip(account.name, 14)
}

function line(account: AccountLimit, compact = false) {
  const name = compact ? shortName(account) : account.name
  if (account.status !== "ok") return `${name}: ${account.message || account.status}`
  if (compact) return `${name}: ${pct(account.fiveHour)} ${resetShort(account.fiveHour)} wk ${pct(account.week)} ${resetShort(account.week)}`
  return `${name}: ${pct(account.fiveHour)} remaining ${reset(account.fiveHour)} week ${pct(account.week)} remaining ${reset(account.week)}`
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
      const command = loginCommand()
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

const LimitsList = (props: { api: TuiPluginApi; compact?: boolean; grid?: boolean }) => {
  const skin = tone(props.api)
  const data = () => snapshot()
  const accountBox = (account: AccountLimit) => (
    <box width={props.grid ? 44 : undefined} onMouseUp={() => openAccountDialog(props.api, account)}>
      <text fg={color(props.api, account)}>{line(account, props.compact)}</text>
    </box>
  )

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={skin.accent}>
          <b>OpenAI limits remaining </b>
        </text>
        <text fg={skin.muted}>{data().loading ? "refreshing" : updated(data().updatedAt)}</text>
      </box>
      {data().accounts.length === 0 ? <text fg={skin.muted}>No OpenAI providers found</text> : null}
      {props.grid
        ? pairs(data().accounts).map((row) => (
            <box flexDirection="row" gap={1}>
              {row.map((account) => accountBox(account))}
            </box>
          ))
        : data().accounts.map((account) => accountBox(account))}
    </box>
  )
}

const RefreshButton = (props: { api: TuiPluginApi; compact?: boolean }) => (
  <ActionButton api={props.api} label={props.compact ? "refresh" : "refresh now"} onClick={() => requestRefresh(props.api)} />
)

const AddProviderButton = (props: { api: TuiPluginApi; compact?: boolean }) => (
  <ActionButton api={props.api} label={props.compact ? "add provider" : "Add OpenAI provider"} onClick={() => openAddProviderDialog(props.api)} />
)

function slots(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 900,
    slots: {
      home_bottom() {
        const skin = tone(api)
        return (
          <box width="100%" maxWidth={118} paddingTop={1} flexShrink={0}>
            <box border borderColor={skin.border} backgroundColor={skin.panel} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
              <LimitsList api={api} compact grid />
            </box>
          </box>
        )
      },
      sidebar_footer() {
        const skin = tone(api)
        return (
          <box border borderColor={skin.border} backgroundColor={skin.panel} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
            <LimitsList api={api} compact />
            <box flexDirection="row" gap={1}>
              <RefreshButton api={api} />
              <AddProviderButton api={api} compact />
            </box>
          </box>
        )
      },
      sidebar_content() {
        const skin = tone(api)
        return (
          <box paddingTop={1} paddingBottom={1} flexDirection="column">
            <box border borderColor={skin.border} backgroundColor={skin.panel} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
              <LimitsList api={api} compact />
              <box flexDirection="row" gap={1}>
                <RefreshButton api={api} />
                <AddProviderButton api={api} compact />
              </box>
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
        <LimitsList api={api} />
        <box flexDirection="row" gap={1}>
          <RefreshButton api={api} />
          <AddProviderButton api={api} />
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
        <text fg={skin.accent}>
          <b>{account.name}</b>
        </text>
        <text fg={skin.muted}>{account.id}</text>
        <text fg={color(api, account)}>{line(account)}</text>
        {account.plan ? <text fg={skin.muted}>plan {account.plan}</text> : null}
        <box flexDirection="row" gap={1}>
          <ActionButton api={api} label={account.status === "missing" ? "login" : "relogin"} primary onClick={() => startProviderLogin(api, account.id, account.name)} />
          <ActionButton api={api} label="refresh now" onClick={() => requestRefresh(api)} />
          {canRemoveProvider(account) ? <ActionButton api={api} label="remove" onClick={() => openRemoveProviderDialog(api, account)} /> : null}
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
        <text fg={skin.muted}>{command}</text>
        <box flexDirection="row" gap={1}>
          <ActionButton api={api} label="refresh now" primary onClick={() => requestRefresh(api)} />
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
      placeholder="openai-work"
      description={() => <text>Creates provider config and opens ChatGPT Pro/Plus browser login.</text>}
      onConfirm={(value) => {
        try {
          const provider = addOpenAIProvider(value)
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
  void refreshLimits()
  const timer = setInterval(() => void refreshLimits(), REFRESH_MS)
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    clearTimeout(refreshPollTimer)
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
