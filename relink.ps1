<#
.SYNOPSIS
    Re-attach the locally linked dsh-session-finder plugin to the desktop DSH profile.

.DESCRIPTION
    Installing, updating or removing any other plugin from the DSH plugin manager
    can rewrite the profile's package.json and drop both this plugin's
    `link:` dependency and its `dsh.profile.bundles` entry. The plugin then
    silently disappears from the UI.

    This script is idempotent: it checks the profile manifest, restores the two
    entries only when they are missing, verifies the node_modules symlink, and
    runs pnpm install when something changed. Nothing outside the desktop
    profile is touched.

.PARAMETER Check
    Report the current state and exit non-zero when repair is needed, without
    changing anything.

.PARAMETER ProfileDir
    Profile directory to inspect. Defaults to the desktop profile under
    %USERPROFILE%\.dsh\profiles\desktop (mainly for testing the script).
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh\profiles\desktop")
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$pluginDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\')
$profileDir = $ProfileDir
$manifestPath = Join-Path $profileDir "package.json"
$pluginName = "dsh-session-finder"
$linkSpec = "link:" + ($pluginDir -replace '\\', '/')

# Returns the absolute directory a node_modules entry points at, or $null.
function Get-LinkTargetPath([string]$path) {
    $item = $null
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
    }
    else {
        try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop }
        catch { return $null }
    }
    if ($null -eq $item.PSObject.Properties['LinkType'] -or $null -eq $item.LinkType) { return $null }
    $raw = @($item.Target) | Where-Object { $_ } | Select-Object -First 1
    if (-not $raw) { return $null }
    if (-not [System.IO.Path]::IsPathRooted([string]$raw)) {
        $raw = Join-Path (Split-Path -Parent $path) ([string]$raw)
    }
    return [System.IO.Path]::GetFullPath([string]$raw).TrimEnd('\')
}

if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Host "错误：找不到 profile 清单 $manifestPath"
    exit 2
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$changes = New-Object 'System.Collections.Generic.List[string]'

$dependency = $manifest.dependencies.PSObject.Properties[$pluginName]
$dependencyOk = $null -ne $dependency -and $dependency.Value -eq $linkSpec
if ($null -eq $dependency) {
    $changes.Add("补回 dependencies.$pluginName")
}
elseif ($dependency.Value -ne $linkSpec) {
    $changes.Add("修正 dependencies.$pluginName（当前 $($dependency.Value)）")
}

$bundles = @($manifest.dsh.profile.bundles)
$bundleOk = $bundles -contains $pluginName
if (-not $bundleOk) {
    $changes.Add("补回 dsh.profile.bundles 中的 $pluginName")
}

$linkPath = Join-Path $profileDir "node_modules\$pluginName"
$linkTarget = Get-LinkTargetPath $linkPath
$linkOk = $null -ne $linkTarget -and $linkTarget -ieq $pluginDir
if ($null -eq $linkTarget) {
    $changes.Add("node_modules\$pluginName 链接缺失")
    $linkState = "缺失"
}
elseif (-not $linkOk) {
    $changes.Add("node_modules\$pluginName 指向错误（当前 $linkTarget）")
    $linkState = "指向错误 -> $linkTarget"
}
else {
    $linkState = "正常 -> $linkTarget"
}

# A UTF-8 BOM or broken JSON in the plugin manifest makes the market report
# "包不可用" even though the link itself is fine, so check it here too.
$pluginManifestPath = Join-Path $pluginDir "package.json"
$pluginManifestState = "正常"
if (-not (Test-Path -LiteralPath $pluginManifestPath)) {
    $pluginManifestState = "缺失"
    $changes.Add("插件 package.json 不存在")
}
else {
    $manifestBytes = [System.IO.File]::ReadAllBytes($pluginManifestPath)
    $hasBom = $manifestBytes.Length -ge 3 -and $manifestBytes[0] -eq 0xEF -and $manifestBytes[1] -eq 0xBB -and $manifestBytes[2] -eq 0xBF
    $manifestText = [System.Text.Encoding]::UTF8.GetString($manifestBytes)
    $jsonError = $null
    try {
        $null = $manifestText | ConvertFrom-Json
    }
    catch {
        $jsonError = $_.Exception.Message
    }
    if ($hasBom) {
        $pluginManifestState = "带 UTF-8 BOM（插件市场会报「包不可用」）"
        $changes.Add("插件 package.json 带 UTF-8 BOM")
    }
    elseif ($null -ne $jsonError) {
        $pluginManifestState = "JSON 解析失败：$jsonError"
        $changes.Add("插件 package.json 不是合法 JSON")
    }
}

Write-Host "插件目录 : $pluginDir"
Write-Host "Profile  : $profileDir"
Write-Host "链接状态 : $linkState"
Write-Host "包清单   : $pluginManifestState"

if ($changes.Count -eq 0) {
    Write-Host "结果     : 已正确挂载，无需修改"
    exit 0
}

Write-Host "待修复   :"
$changes | ForEach-Object { Write-Host "  - $_" }

if ($Check) {
    Write-Host "结果     : 需要修复（-Check 模式未做任何修改）"
    exit 1
}

# Restore only the two entries; every other dependency and bundle is preserved.
if ($null -eq $dependency) {
    $manifest.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkSpec
}
else {
    $dependency.Value = $linkSpec
}
if (-not $bundleOk) {
    $manifest.dsh.profile.bundles = @($bundles) + $pluginName
}
$json = ($manifest | ConvertTo-Json -Depth 100) + "`n"
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写入  : $manifestPath"

# Strip the BOM in place: rewriting the same bytes minus the first three keeps
# the manifest content identical while making it parseable for the market.
if ($hasBom) {
    $clean = ([System.Text.Encoding]::UTF8.GetString($manifestBytes)).TrimStart([char]0xFEFF)
    [System.IO.File]::WriteAllText($pluginManifestPath, $clean, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已修复  : 去掉 $pluginManifestPath 的 UTF-8 BOM"
}

# A wrong or dangling link must go before pnpm can recreate it.
if ($null -ne $linkTarget -and -not $linkOk) {
    Remove-Item -LiteralPath $linkPath -Force -Recurse
    Write-Host "已删除  : 旧链接 $linkPath"
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$bundledPnpm = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
Push-Location $profileDir
try {
    if ($null -ne $pnpmCommand) {
        & $pnpmCommand.Source install
    }
    elseif (Test-Path -LiteralPath $bundledPnpm) {
        & node $bundledPnpm install
    }
    else {
        Write-Host "错误：找不到 pnpm，请手动在 $profileDir 执行 pnpm install"
        exit 3
    }
    $installCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($installCode -ne 0) {
    Write-Host "错误：pnpm install 失败（退出码 $installCode），插件未完成挂载"
    exit 4
}

$linkTarget = Get-LinkTargetPath $linkPath
if ($null -eq $linkTarget -or $linkTarget -ine $pluginDir) {
    Write-Host "错误：安装后链接仍不正确（$linkTarget）"
    exit 5
}
Write-Host "结果     : 已恢复挂载 -> $linkTarget"
Write-Host "下一步   : 重启 DSH 桌面端后生效"
exit 0