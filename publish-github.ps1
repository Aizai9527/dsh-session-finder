#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot: put dsh-session-finder on GitHub and publish it to npm.

.DESCRIPTION
  Run this after creating an EMPTY public repository on GitHub (no README, no
  license) named after -Repo. The script fills in package.json's repository
  field, initialises git, commits, tags the version and pushes over HTTPS.

  Nothing here talks to the GitHub API: creating the repository is a click on
  github.com, the push uses your Git Credential Manager login.

.EXAMPLE
  ./publish-github.ps1 -Owner yourname

.EXAMPLE
  ./publish-github.ps1 -Owner yourname -SkipPush
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Owner,
  [string] $Repo = "dsh-session-finder",
  [string] $Name = "",
  [string] $Email = "",
  [switch] $SkipPush
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not $Name) { $Name = $Owner }
if (-not $Email) { $Email = "$Owner@users.noreply.github.com" }

$manifest = Get-Content -Raw package.json | ConvertFrom-Json
$version = $manifest.version
$url = "https://github.com/$Owner/$Repo"

Write-Host "==> repository field: $url (version $version)"

# 1. package.json: point npm back at the repository (the market links the two by this field).
$patch = @"
import fs from "node:fs";
const file = "package.json";
const json = JSON.parse(fs.readFileSync(file, "utf8"));
json.repository = { type: "git", url: "git+$url.git" };
json.homepage = "$url#readme";
json.bugs = { url: "$url/issues" };
json.author = "$Name";
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
"@
$patchFile = Join-Path ([System.IO.Path]::GetTempPath()) "sf-repo-field.mjs"
[System.IO.File]::WriteAllText($patchFile, $patch, (New-Object System.Text.UTF8Encoding($false)))
node $patchFile
if ($LASTEXITCODE -ne 0) { throw "failed to update package.json" }
Remove-Item $patchFile -Force

# 2. sanity checks before anything leaves the machine.
node --check lib/client.js
node --check lib/index.js
node --check lib/search.js
if ($LASTEXITCODE -ne 0) { throw "syntax check failed" }
npm test
if ($LASTEXITCODE -ne 0) { throw "tests failed" }

# 3. git: init once, commit, tag.
if (-not (Test-Path .git)) {
  git init -b main
  if ($LASTEXITCODE -ne 0) { throw "git init failed" }
}
git config user.name $Name
git config user.email $Email
git add -A
git commit -m "dsh-session-finder v$version"
if ($LASTEXITCODE -ne 0) { Write-Host "==> nothing new to commit, continuing" }

$tag = "v$version"
if (-not (git tag --list $tag)) {
  git tag -a $tag -m "dsh-session-finder $version"
}

if ($SkipPush) {
  Write-Host "==> -SkipPush: repository is committed locally, not pushed."
} else {
  $remote = git remote get-url origin 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $remote) {
    git remote add origin "$url.git"
  } else {
    git remote set-url origin "$url.git"
  }
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw "push failed - finish the browser login, then rerun" }
  git push origin $tag
}

Write-Host @"

==> done: $url
Next:
  1. repository > Settings: add topic  dsh-plugin
  2. npm publish --access public        (optional, adds a download counter)
  3. open the pull request described in docs/market-entry.yml
"@
