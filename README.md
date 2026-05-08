# OpenCode OpenAI Limits

OpenCode TUI plugin for tracking ChatGPT Pro/Plus Codex usage across multiple OpenAI accounts.

Use it when you work with several OpenAI accounts and need one place to see remaining limits, refresh usage, add providers, relogin, and remove accounts without hand-editing config files.

## Preview

Add screenshots here before publishing a polished release:

- `docs/screenshots/preview.png` - main OpenAI limits panel.
- `docs/screenshots/provider-management.png` - account/provider management dialog.

```md
![OpenAI limits preview](docs/screenshots/preview.png)
![Provider management](docs/screenshots/provider-management.png)
```

## Features

- Shows remaining ChatGPT Pro/Plus Codex usage inside OpenCode.
- Discovers OpenAI providers from OpenCode config and local auth.
- Adds new OpenAI providers from the TUI with `/limits-add`.
- Opens browser OAuth login for each provider.
- Supports relogin and remove actions from the provider dialog.
- Keeps credentials local in OpenCode's own auth store.
- Uses a background writer plugin so usage stays fresh without blocking the TUI.

## Commands

- `/limits` - open the full limits dialog.
- `/limits-refresh` - refresh current usage.
- `/limits-add` - add a new OpenAI provider and start browser login.
- Click a provider row - login, relogin, refresh, or remove that provider.

## Install

Clone this repo or download the files, then run from the repo root:

```powershell
.\install.ps1
```

This copies the plugin files into:

```text
%USERPROFILE%\.config\opencode\plugins
```

Add the background writer plugin to `%USERPROFILE%\.config\opencode\opencode.jsonc`:

```jsonc
{
  "plugin": ["./plugins/openai-limits-writer.ts"]
}
```

If you already have a `plugin` array, append `"./plugins/openai-limits-writer.ts"` to it.

Add the TUI plugin to `%USERPROFILE%\.config\opencode\tui.jsonc`:

```jsonc
{
  "plugin": ["./plugins/openai-limits.tsx"]
}
```

If you already have a `plugin` array, append `"./plugins/openai-limits.tsx"` to it.

Restart OpenCode after installing.

## Multi-Account Flow

1. Run `/limits-add`.
2. Enter a provider id, for example `openai-work` or `openai-alt`.
3. Finish the browser login with the OpenAI account you want attached to that provider.
4. Run `/limits-refresh`.
5. Click any provider row later to relogin, refresh, or remove it.

The plugin creates provider config automatically and stores the OAuth credential under that provider id in your local OpenCode auth file.

## Files

- `plugins/openai-limits.tsx` - TUI panel, dialogs, add/login/relogin/remove actions.
- `plugins/openai-limits-writer.ts` - background usage cache writer.
- `plugins/openai-limits-shared.ts` - shared config, auth discovery, and provider helpers.
- `install.ps1` - local installer for Windows PowerShell.

## Security

This repository does not contain OpenAI credentials.

Do not commit or share these local runtime files:

- `%USERPROFILE%\.local\share\opencode\auth.json`
- `%USERPROFILE%\.local\share\opencode\openai-limits.json`
- `%USERPROFILE%\.local\share\opencode\openai-limits.refresh`
- `%USERPROFILE%\.local\share\opencode\openai-limits-login*.cmd`
- `%USERPROFILE%\.local\share\opencode\openai-limits-*.cjs`

OpenCode stores each developer's local OAuth credentials in their own `auth.json` after browser login.

The plugin contains a public OpenAI OAuth app id used by OpenCode browser login. That value is not a user secret.

## Notes

- Tested on Windows with OpenCode's TUI plugin system.
- The usage data is cached locally and can be rebuilt with `/limits-refresh`.
- Removing a provider deletes its provider config and its local credential for that provider id.
