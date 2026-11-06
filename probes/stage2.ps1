param(
    [Parameter(Mandatory)][string]$PaseoCli,
    [string]$DshCli = (Get-Command dsh.cmd -ErrorAction Stop).Source,
    [string]$CredentialsPath = (Join-Path $env:USERPROFILE '.dsh/.credentials.yaml')
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cli = (Resolve-Path $PaseoCli).Path
$dshCommand = (Resolve-Path $DshCli).Path
$credentials = (Resolve-Path $CredentialsPath).Path
$plugin = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ('paseo-dsh-stage2-' + [guid]::NewGuid().ToString('N'))
$testHome = Join-Path $root 'paseo'
$daemonCwd = Join-Path $root 'daemon directory A'
$workspace = Join-Path $root 'workspace B'
$repository = Join-Path $root 'repository'
$worktree = Join-Path $root 'worktree C'
$null = New-Item -ItemType Directory -Path $testHome,$daemonCwd,$workspace,$repository
Write-Host "Test artifacts: $root"
Write-Host "DSH executable: $dshCommand"
& $dshCommand --version

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$endpoint = "127.0.0.1:$($listener.LocalEndpoint.Port)"
$listener.Stop()
$patch = Join-Path $root 'production.yml'
@"
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  config:
    path: $(ConvertTo-Json $credentials -Compress)
    watch: false
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: $(ConvertTo-Json (Join-Path $root 'sessions') -Compress)
    compression: none
- id: session-log-deepseek
  config:
    enabled: false
"@ | Set-Content $patch
$config = @{
    version = 1; pluginsEnabled = $true
    features = @{ dictation = @{ enabled = $false }; voiceMode = @{ enabled = $false } }
    daemon = @{ listen = $endpoint; relay = @{ enabled = $false } }
    agents = @{ providers = @{ dsh = @{
        command = @($dshCommand, '--profile', 'acp', '--patch', $patch)
        env = @{
            DSH_HOME = (Join-Path $root 'dsh')
            DSH_AGENTS_HOME = (Join-Path $root 'agents')
            DSH_TELEMETRY_DISABLED = '1'
        }
    } } }
}
$config | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $testHome 'config.json')
function Invoke-TestCli { & $node $cli --host $endpoint --json @args }
function Assert-NoDshProcess {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($patch) })
        if (!$remaining.Count) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Test DSH processes remained: $($remaining.ProcessId -join ', ')"
}
$helper = Join-Path $root 'timeline.mjs'
@'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const [cli, endpoint, agentId] = process.argv.slice(2)
const base = path.resolve(path.dirname(cli), '../dist')
const { connectToDaemon } = await import(pathToFileURL(path.join(base, 'utils/client.js')))
const { fetchAgentTimelineItems } = await import(pathToFileURL(path.join(base, 'commands/agent/logs.js')))
const client = await connectToDaemon({ target: { kind: 'endpoint', host: endpoint } })
try { console.log(JSON.stringify(await fetchAgentTimelineItems(client, agentId))) }
finally { await client.close() }
'@ | Set-Content $helper

function Assert-Workspace([string]$cwd, [string]$label) {
    $markerName = 'workspace-marker.txt'
    $outputName = 'workspace-answer.txt'
    $value = [guid]::NewGuid().ToString('N')
    Set-Content -LiteralPath (Join-Path $cwd $markerName) -Value $value -NoNewline
    if (!(Test-Path -LiteralPath (Join-Path $cwd $markerName)) -or (Get-Content -LiteralPath (Join-Path $cwd $markerName) -Raw) -ne $value) {
        throw "The $label marker was not provisioned before the real-model request"
    }
    $prompt = "Use the native read tool to read relative file $markerName in the current workspace. Then use the native write tool to create relative file $outputName containing exactly the value you read. Reply with that value only. Do not use shell, do not change directory, and do not read another directory."
    $first = Invoke-TestCli run --provider dsh --new-workspace local --cwd $cwd --title "DSH stage 2 $label" --wait-timeout 3m $prompt | ConvertFrom-Json
    $first | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $root "$label-first.json")
    if ($first.status -ne 'completed' -or $first.cwd -ne $cwd) { throw "Real-model first turn failed in $label" }
    $text = (& $node $cli --host $endpoint logs $first.agentId --filter text) -join [Environment]::NewLine
    Set-Content (Join-Path $root "$label-transcript.txt") $text
    if (!$text.Contains($value)) { throw "The real model did not read the unique $label value" }
    if (!(Test-Path (Join-Path $cwd $outputName)) -or (Get-Content (Join-Path $cwd $outputName) -Raw).Trim() -ne $value) {
        throw "The real model did not write the exact $label value in the requested workspace"
    }
    if (Test-Path (Join-Path $daemonCwd $outputName)) { throw 'Relative write landed in daemon directory A' }
    $timelineJson = & $node $helper $cli $endpoint $first.agentId
    Set-Content (Join-Path $root "$label-timeline.json") $timelineJson
    $timeline = @($timelineJson | ConvertFrom-Json)
    $tools = @($timeline | Where-Object type -eq 'tool_call')
    if ($tools.Count -lt 2 -or @($tools | Where-Object status -eq 'running').Count) { throw 'Expected completed native read and write tool rows' }
    $logs = @(Get-ChildItem (Join-Path $root 'sessions') -Filter session.v4.jsonl -Recurse |
        Where-Object { $body = Get-Content $_ -Raw; $header = Get-Content $_ -TotalCount 1 | ConvertFrom-Json; $header.cwd -eq $cwd -and $body.Contains($prompt) -and $body.Contains('turn/start') })
    if ($logs.Count -ne 1) { throw 'Expected one real DSH session with the prompt and requested workspace cwd' }
    $events = @(Get-Content $logs[0] | ForEach-Object { $_ | ConvertFrom-Json })
    $toolNames = @($events | Where-Object type -eq 'tool/call' | ForEach-Object { $_.data.name })
    if ('read' -notin $toolNames -or 'write' -notin $toolNames) { throw 'The real model did not use both native read and write tools' }
    [pscustomobject]@{ paseoId = $first.agentId; dshId = $events[0].id; cwd = $events[0].cwd } |
        ConvertTo-Json | Set-Content (Join-Path $root "$label-ids.json")
    $second = Invoke-TestCli send $first.agentId 'Reply with exactly CONTINUED and do not use any tools.' | ConvertFrom-Json
    $second | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $root "$label-second.json")
    if ($second.status -ne 'completed') { throw "Real-model second turn failed in $label" }
    $events = @(Get-Content $logs[0] | ForEach-Object { $_ | ConvertFrom-Json })
    if (@($events | Where-Object type -eq 'turn/end').Count -ne 2) { throw 'Expected both real-model turns in the same DSH session' }
    Write-Host "PASS: real model read and wrote the unique $label value through native tools, then completed another turn."
}

try {
    Set-Content -LiteralPath (Join-Path $daemonCwd 'workspace-marker.txt') -Value ([guid]::NewGuid().ToString('N')) -NoNewline
    if (!(Test-Path -LiteralPath (Join-Path $daemonCwd 'workspace-marker.txt'))) { throw 'Directory A marker was not provisioned' }
    & git -C $repository init --quiet
    Set-Content (Join-Path $repository 'README.md') 'Isolated DSH workspace verification.'
    & git -C $repository add README.md
    & git -C $repository -c user.name='DSH probe' -c user.email='dsh-probe@example.invalid' commit --quiet -m 'Create isolated verification repository'
    & git -C $repository worktree add --quiet -b dsh-verification $worktree
    Push-Location $daemonCwd
    try { & $node $cli daemon start --home $testHome }
    finally { Pop-Location }
    Invoke-TestCli plugin install $plugin | Out-Host
    Assert-Workspace $workspace 'workspace'
    Assert-Workspace $worktree 'worktree'
} finally {
    & $node $cli daemon stop --home $testHome
    Assert-NoDshProcess
}
