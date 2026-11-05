<#
.SYNOPSIS
  Install (or remove) dsh-suggest-actions in a DSH profile.

.DESCRIPTION
  Registers this directory as a `link:` dependency of the profile through the
  dsh CLI, so pnpm materializes it in <profile>/node_modules and keeps it across
  later `dsh plugin` operations, then keeps a single `dsh-suggest-actions` entry
  in that profile's dsh.profile.bundles. Quit the DSH app before running.

  The `-Copy` fallback copies the files instead. That copy carries no lockfile
  entry, so the next `dsh plugin` operation prunes it and the app then fails with
  `cannot resolve profile bundle`. Use it only when no dsh CLI is available.

.PARAMETER Profile
  Profile directory name under ~/.dsh/profiles. Defaults to `desktop`.

.PARAMETER Cli
  Path to the dsh CLI (`dsh` or `dsh.cmd`). Defaults to $env:DSH_CLI, then `dsh`
  on PATH.

.PARAMETER Uninstall
  Remove the bundle entry and the installed dependency instead of installing.

.PARAMETER Copy
  Copy the package into the profile instead of registering a link dependency.

.PARAMETER DryRun
  Print the planned actions without writing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -Cli "E:\DSH-Desktop\resources\runtime\cli\bin\dsh.cmd"
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -Profile web -DryRun
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$Cli = '',
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-suggest-actions'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
$profileJson = Join-Path $profileDir 'package.json'
$target = Join-Path (Join-Path $profileDir 'node_modules') $packageName

if (-not (Test-Path $profileJson)) {
  throw "DSH profile not found: $profileJson. Start DSH once with --profile $Profile, or pass -Profile <name>."
}
foreach ($file in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\route.mjs', 'lib\suggest.mjs', 'client\client.js')) {
  if (-not (Test-Path (Join-Path $source $file))) { throw "Not a complete plugin copy: missing $file under $source" }
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(DSH-Desktop|dsh-desktop|DeepSeek Harness)$' }
if ($running -and -not $DryRun) {
  throw 'DSH appears to be running. Quit the app first so it cannot rewrite the profile while this script edits it.'
}

# Resolve the dsh CLI: explicit -Cli, then DSH_CLI, then PATH.
$cliPath = ''
if (-not $Copy) {
  if ($Cli) {
    if (-not (Test-Path $Cli)) { throw "dsh CLI not found at -Cli path: $Cli" }
    $cliPath = $Cli
  } elseif ($env:DSH_CLI) {
    if (-not (Test-Path $env:DSH_CLI)) { throw "dsh CLI not found at DSH_CLI: $($env:DSH_CLI)" }
    $cliPath = $env:DSH_CLI
  } else {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { $cliPath = $command.Source }
  }
  if (-not $cliPath) {
    throw 'No dsh CLI found. Pass -Cli <path to dsh.cmd>, set DSH_CLI, or use -Copy as an offline fallback (its files are pruned by the next dsh plugin operation).'
  }
}

$document = Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $document.dsh) { throw "Profile package.json has no dsh section: $profileJson" }
if (-not $document.dsh.profile) { $document.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
$bundles = @()
if ($document.dsh.profile.PSObject.Properties.Name -contains 'bundles' -and $document.dsh.profile.bundles) {
  $bundles = @($document.dsh.profile.bundles)
}
$hasEntry = $bundles -contains $packageName
$linkSpec = 'link:' + ($source -replace '\\', '/')

Write-Host "Profile : $profileDir"
Write-Host "Source  : $source"
Write-Host "Mode    : $(if ($Copy) { 'copy (offline fallback)' } else { 'link dependency' })"
if ($cliPath) { Write-Host "CLI     : $cliPath" }
if ($Uninstall) {
  Write-Host 'Action  : uninstall'
  if ($hasEntry) { $bundles = @($bundles | Where-Object { $_ -ne $packageName }) }
} else {
  Write-Host 'Action  : install'
  if (-not $hasEntry) { $bundles += $packageName }
}

if ($DryRun) {
  if ($Copy) { Write-Host "Would copy: $source -> $target" }
  elseif ($Uninstall) { Write-Host "Would run : dsh plugin --profile $Profile remove $packageName" }
  else { Write-Host "Would run : dsh plugin --profile $Profile add $linkSpec" }
  Write-Host "Would set dsh.profile.bundles to: $($bundles -join ', ')"
  Write-Host 'Dry run: nothing written.'
  return
}

# The dependency registry is the durable half: pnpm owns node_modules and prunes
# anything its lockfile does not know about.
if (-not $Copy) {
  if ($Uninstall) { & $cliPath plugin --profile $Profile remove $packageName }
  else { & $cliPath plugin --profile $Profile add $linkSpec }
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin exited with code $LASTEXITCODE; the profile was not changed." }
} elseif ($Uninstall) {
  if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
    Write-Host 'Removed the copied package.'
  }
} else {
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($item in @('package.json', 'README.md', 'cordis.patch.yml', 'lib', 'client')) {
    Copy-Item -Recurse -Force (Join-Path $source $item) $target
  }
  Write-Warning 'Copied without a lockfile entry: a later `dsh plugin` operation will prune this directory.'
}

$document = Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
$document.dsh.profile.bundles = $bundles
[System.IO.File]::WriteAllText($profileJson, (($document | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
Write-Host $(if ($Uninstall) { 'Removed the bundle entry.' } else { 'Wrote the bundle entry.' })

if (-not $Uninstall -and -not (Test-Path (Join-Path $target 'package.json'))) {
  throw "Installed dependency does not resolve at $target; the app would fail with 'cannot resolve profile bundle'."
}

Write-Host ''
Write-Host $(if ($Uninstall) { 'Uninstalled. Restart DSH.' } else { 'Installed. Restart DSH, then finish one assistant turn to see the suggestion card.' })
