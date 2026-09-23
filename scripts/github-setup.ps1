<#
  Fills in the GitHub repository's "About" box — description, website and topics — so
  people searching GitHub for an AI video editor find Lumen. Run it once after you've
  created the repository and pushed the code.

  Needs the GitHub CLI (winget install GitHub.cli, then gh auth login).

    .\scripts\github-setup.ps1                  # the repository this folder's git remote points at
    .\scripts\github-setup.ps1 -Repo you/lumen  # or name it
#>
param([string]$Repo)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install the GitHub CLI first: winget install GitHub.cli' }

$description = 'Open-source AI video editor for Windows: timeline editing, frame-exact export, on-device Whisper captions, Blender and HyperFrames motion graphics, and an AI Copilot (Claude Code, Codex, OpenAI, Gemini or any MCP agent) that can see, hear and edit your video.'

# GitHub allows 20 topics. These are the terms people actually browse and search for.
$topics = @(
  'video-editor', 'ai-video-editor', 'video-editing', 'ai', 'ai-agents', 'llm', 'mcp',
  'model-context-protocol', 'claude-code', 'codex', 'openai', 'whisper', 'subtitles',
  'electron', 'react', 'typescript', 'webcodecs', 'blender', 'motion-graphics', 'vibe-coding'
)

$target = if ($Repo) { @($Repo) } else { @() }
$url = gh repo view @target --json url -q .url
$name = gh repo view @target --json nameWithOwner -q .nameWithOwner

gh repo edit @target `
  --description $description `
  --homepage "$url/releases/latest" `
  --add-topic ($topics -join ',') `
  --enable-issues `
  --enable-discussions

# SECURITY.md sends people to Security → "Report a vulnerability", which needs this switched on.
gh api --method PUT "repos/$name/private-vulnerability-reporting" --silent

Write-Host "Done: $url"
Write-Host ''
Write-Host 'One thing the CLI can''t do: set the social preview image (what Twitter, Discord and Slack show for links).'
Write-Host "Upload docs/assets/social-preview.png at $url/settings → General → Social preview."
