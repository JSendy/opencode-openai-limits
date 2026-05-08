$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "plugins"
$target = Join-Path $HOME ".config\opencode\plugins"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Missing source plugin folder: $source"
}

New-Item -ItemType Directory -Path $target -Force | Out-Null

$files = @(
  "openai-limits.tsx",
  "openai-limits-writer.ts",
  "openai-limits-shared.ts",
  "openai-limits.README.md"
)

foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $target $file) -Force
}

Write-Host "Installed OpenAI limits plugin files to: $target"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Add ./plugins/openai-limits-writer.ts to opencode.jsonc plugin array."
Write-Host "2. Add ./plugins/openai-limits.tsx to tui.jsonc plugin array."
Write-Host "3. Restart OpenCode."
Write-Host "4. Run /limits-add or open /limits and login through the browser."
