# OpenAI Limits Plugin

OpenCode TUI plugin for ChatGPT Pro/Plus Codex usage limits.

## Files

- `openai-limits.tsx` - TUI panel, dialog, add-provider and relogin actions.
- `openai-limits-writer.ts` - background cache writer.
- `openai-limits-shared.ts` - shared config discovery and safe provider setup.

## Install

Copy these three plugin files into `~/.config/opencode/plugins`, or run the installer from the repository root:

```sh
sh ./install.sh
```

On Windows:

```powershell
.\install.ps1
```

Add the writer plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["./plugins/openai-limits-writer.ts"]
}
```

Add the TUI plugin to `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "plugin": ["./plugins/openai-limits.tsx"]
}
```

## Usage

- `/limits` opens the full limits dialog.
- `/limits-refresh` refreshes current usage.
- `/limits-add` adds a new OpenAI provider and starts ChatGPT Pro/Plus browser login.
- Click any provider row to login, relogin, or remove that provider.

## Credentials

Do not copy `~/.local/share/opencode/auth.json`.

This plugin does not include account credentials. OpenCode stores each developer's local credentials in `~/.local/share/opencode/auth.json` after browser login.
