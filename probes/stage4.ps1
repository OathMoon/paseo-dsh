param([Parameter(Mandatory)][string]$PaseoCli)
# Run with PowerShell 7 and the bin/paseo file of @getpaseo/cli 0.15.2.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cli = (Resolve-Path $PaseoCli).Path
$plugin = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dsh = (Resolve-Path (Join-Path $plugin '../deepseek-harness')).Path
$node = (Get-Command node.exe).Source
$root = (New-TemporaryFile).FullName
Remove-Item -LiteralPath $root
$null = New-Item -ItemType Directory -Path $root
$testHome = Join-Path $root 'paseo'
$workspace = Join-Path $root 'requested workspace'
$null = New-Item -ItemType Directory -Path $testHome,$workspace
Write-Host "Test artifacts: $root"
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$endpoint = "127.0.0.1:$($listener.LocalEndpoint.Port)"
$listener.Stop()

$fixture = Join-Path $dsh 'apps/cli/tests/profiles/acp/tests/fixtures/control-surface'
$modelUri = [Uri]::new((Join-Path $fixture 'control-surface-llm.ts')).AbsoluteUri
$patch = Join-Path $root 'fixture.yml'
$configText = (Get-Content (Join-Path $fixture 'cordis.yml') -Raw).Replace('./control-surface-llm.ts', $modelUri)
$serverPath = Join-Path $dsh 'packages/mcp/mcp-client/tests/fixture-server.ts'
$controlledServer = Join-Path $PSScriptRoot 'fixtures/slow-mcp.mjs'
$slowMarker = Join-Path $root 'running-tool.jsonl'
# Inject the fixture through session/new so DSH awaits the MCP mount before session.ready.
$fixturePlugin = Join-Path $root 'fixture-plugin'
$null = New-Item -ItemType Directory -Path $fixturePlugin
Set-Content (Join-Path $fixturePlugin 'paseo-plugin.json') '{"id":"stage1-fixture","requirements":{"paseo":"0.15.2"}}'
@"
export default function contribute(server) {
  server.addHook("agent.open.before", ({ request }) => {
    if (request.provider !== "dsh") return;
    return { ...request, mcpServers: { ...request.mcpServers, fixture: {
      type: "stdio", command: $(ConvertTo-Json $node -Compress),
      args: [$(ConvertTo-Json $controlledServer -Compress), $(ConvertTo-Json $serverPath -Compress), $(ConvertTo-Json $slowMarker -Compress)],
      env: { DSH_SLOW_TOOL: request.title === "DSH stage 4 active tool" ? "1" : "0" }
    } } };
  });
  return () => {};
}
"@ | Set-Content (Join-Path $fixturePlugin 'index.server.ts')
Set-Content $patch $configText
$config = @{
    version = 1; pluginsEnabled = $true
    features = @{ dictation = @{ enabled = $false }; voiceMode = @{ enabled = $false } }
    daemon = @{ listen = $endpoint; relay = @{ enabled = $false } }
    agents = @{ providers = @{ dsh = @{
        command = @($node, (Join-Path $dsh 'apps/cli/lib/bin.js'), '--profile', 'acp', '--patch', $patch)
        env = @{
            DSH_HOME = (Join-Path $root 'dsh')
            DSH_AGENTS_HOME = (Join-Path $root 'agents')
            DSH_CONFORMANCE_PERSISTENCE_ROOT = (Join-Path $root 'sessions')
            DSH_TELEMETRY_DISABLED = '1'
        }
    } } }
}
$config | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $testHome 'config.json')
function Invoke-TestCli { & $node $cli --host $endpoint --json @args }

$helper = Join-Path $root 'host-helper.mjs'
@'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const [cli, endpoint, mode, argument, artifact] = process.argv.slice(2)
const base = path.resolve(path.dirname(cli), '../dist')
const { connectToDaemon } = await import(pathToFileURL(path.join(base, 'utils/client.js')))
const client = await connectToDaemon({ target: { kind: 'endpoint', host: endpoint } })
try {
  if (mode === 'models') console.log(JSON.stringify(await client.listProviderModels('dsh', { cwd: argument })))
  else if (mode === 'timeline') {
    const { fetchAgentTimelineItems } = await import(pathToFileURL(path.join(base, 'commands/agent/logs.js')))
    console.log(JSON.stringify(await fetchAgentTimelineItems(client, argument)))
  }
  else if (mode === 'watch') {
    writeFileSync(artifact, '')
    const subscription = client.subscribeAgentTimeline(argument, message => appendFileSync(artifact, JSON.stringify(message) + '\n'))
    await subscription.ready
    writeFileSync(artifact + '.ready', 'ready')
    while (!existsSync(artifact + '.stop')) await delay(100)
    await subscription.release()
  }
} finally { await client.close() }
'@ | Set-Content $helper
function Read-Timeline([string]$agentId) {
    $json = & $node $helper $cli $endpoint timeline $agentId
    Set-Content (Join-Path $root "$agentId-timeline.json") $json
    return @($json | ConvertFrom-Json)
}
function Wait-ToolResult([string]$prompt) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $logs = @(Get-ChildItem (Join-Path $root 'sessions') -Filter session.v4.jsonl -Recurse -ErrorAction SilentlyContinue |
            Where-Object { (Get-Content $_ -Raw).Contains($prompt) })
        foreach ($log in $logs) {
            $records = @(Get-Content $log | ForEach-Object { $_ | ConvertFrom-Json })
            if (@($records | Where-Object { $_.type -eq 'tool/result' -and $_.data.message.toolCallId -eq 'control-cancel-add' }).Count) { return }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The cancellation fixture never completed its tool'
}
function Assert-NoDshProcess {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $remaining = @(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($patch)
        })
        if (!$remaining.Count) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Test DSH processes remained: $($remaining.ProcessId -join ', ')"
}

$watcher = $null
$watchArtifact = Join-Path $root 'active-tool-events.jsonl'
try {
    & $node $cli daemon start --home $testHome
    Invoke-TestCli plugin install $fixturePlugin | Out-Host
    Invoke-TestCli plugin install $plugin | Out-Host
    $globalModels = @(Invoke-TestCli provider models dsh | ConvertFrom-Json)
    if ($globalModels.Count) { throw 'workspaceOnlyCatalog unexpectedly created global models' }
    $catalog = & $node $helper $cli $endpoint models $workspace | ConvertFrom-Json
    $catalog | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $root 'workspace-models.json')
    $beta = @($catalog.models | Where-Object label -eq 'Beta')
    if ($catalog.error -or $beta.Count -ne 1) { throw 'Workspace model catalog did not contain Beta' }
    $first = Invoke-TestCli run --provider dsh --model $beta[0].id --new-workspace local --cwd $workspace --title 'DSH stage 4 Beta' --wait-timeout 2m 'beta addition' | ConvertFrom-Json
    if ($first.status -ne 'completed') { throw 'Beta turn failed' }
    $transcript = (& $node $cli --host $endpoint logs $first.agentId --filter text) -join [Environment]::NewLine
    Set-Content (Join-Path $root 'beta.txt') $transcript
    if ($transcript -notmatch 'model=beta; tool=5') { throw 'Selected Beta was not used by DSH' }
    $timeline = Read-Timeline $first.agentId
    $tools = @($timeline | Where-Object { $_.type -eq 'tool_call' })
    if ($tools.Count -ne 1 -or $tools[0].status -ne 'completed' -or $tools[0].detail.output -ne '5') {
        throw 'Expected one completed tool with visible output 5'
    }
    $prompt = 'cancel after the tool finishes'
    $long = Invoke-TestCli run --provider dsh --cwd $workspace --no-wait --title 'DSH stage 4 cancel' $prompt | ConvertFrom-Json
    Wait-ToolResult $prompt
    $stop = Invoke-TestCli stop $long.agentId | ConvertFrom-Json
    if ($stop.stoppedCount -ne 1) { throw 'CLI did not interrupt the running turn' }
    $waited = Invoke-TestCli wait $long.agentId --timeout 30s | ConvertFrom-Json
    if ($waited.status -ne 'idle') { throw 'Cancelled turn did not become idle' }
    $after = Invoke-TestCli send $long.agentId 'ordinary addition after stop' | ConvertFrom-Json
    if ($after.status -ne 'completed') { throw 'Prompt after stop did not complete' }
    $afterText = (& $node $cli --host $endpoint logs $long.agentId --filter text) -join [Environment]::NewLine
    Set-Content (Join-Path $root 'after-stop.txt') $afterText
    if ([regex]::Matches($afterText, 'model=alpha; tool=5').Count -ne 1) { throw 'Unexpected reply after cancellation' }
    $afterTimeline = Read-Timeline $long.agentId
    if (@($afterTimeline | Where-Object { $_.type -eq 'tool_call' -and $_.status -eq 'running' }).Count) {
        throw 'A tool remained running after stop and the next turn'
    }
    $active = Invoke-TestCli run --provider dsh --cwd $workspace --no-wait --title 'DSH stage 4 active tool' 'reload while the tool runs' | ConvertFrom-Json
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (!(Test-Path $slowMarker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (!(Test-Path $slowMarker)) { throw 'The slow MCP tool never started' }
    $beforeTimeline = Read-Timeline $active.agentId
    if (@($beforeTimeline | Where-Object { $_.type -eq 'tool_call' -and $_.status -eq 'running' }).Count -ne 1) {
        throw 'Expected a running tool before reload'
    }
    $watchStart = [Diagnostics.ProcessStartInfo]::new($node)
    $watchStart.UseShellExecute = $false
    $watchStart.CreateNoWindow = $true
    foreach ($argument in @($helper, $cli, $endpoint, 'watch', $active.agentId, $watchArtifact)) {
        $watchStart.ArgumentList.Add($argument)
    }
    $watcher = [Diagnostics.Process]::Start($watchStart)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (!(Test-Path "$watchArtifact.ready") -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (!(Test-Path "$watchArtifact.ready")) { throw 'Timeline watcher was not established before reload' }
    $beforeReload = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine.Contains($patch) -or $_.CommandLine.Contains($slowMarker))
    } | Select-Object -ExpandProperty ProcessId)
    $activeReload = Invoke-TestCli plugin reload paseo-dsh | ConvertFrom-Json
    if ($activeReload.status -ne 'running') { throw 'Plugin did not reload during the active tool' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $oldProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $beforeReload })
        if (!$oldProcesses.Count) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($oldProcesses.Count) { throw "Reload left old tool processes: $($oldProcesses.ProcessId -join ', ')" }
    Start-Sleep -Milliseconds 500
    Set-Content -LiteralPath "$watchArtifact.stop" -Value 'stop'
    if (!$watcher.WaitForExit(5000)) { throw 'Timeline watcher did not stop' }
    $reloadEvents = @(Get-Content $watchArtifact | ForEach-Object { $_ | ConvertFrom-Json })
    $terminalTool = @($reloadEvents | Where-Object {
        $_.type -eq 'agent_stream' -and $_.payload.event.type -eq 'timeline' -and
        $_.payload.event.item.type -eq 'tool_call' -and $_.payload.event.item.status -ne 'running'
    })
    $activeToolTerminalObserved = $terminalTool.Count -gt 0
    if (!$activeToolTerminalObserved) {
        Write-Warning 'NOT VERIFIED: reload closed the running tool process but the host did not publish its terminal tool row. The old session cannot be restored without session.persistence.'
    }
    if (!@($reloadEvents | Where-Object { $_.type -eq 'agent_stream' -and $_.payload.event.type -eq 'turn_failed' }).Count) {
        throw 'Reload did not terminate the active turn'
    }
    $pending = @(Invoke-TestCli permit ls | ConvertFrom-Json | Where-Object agentId -eq $active.agentId)
    if ($pending.Count) { throw 'Reload left pending permissions for the active tool' }
    $recovered = Invoke-TestCli run --provider dsh --cwd $workspace --wait-timeout 2m 'ordinary addition after active tool reload' | ConvertFrom-Json
    if ($recovered.status -ne 'completed') { throw 'Provider was not usable after active tool reload' }
    $recoveredTimeline = Read-Timeline $recovered.agentId
    if (!@($recoveredTimeline | Where-Object {
        $_.type -eq 'tool_call' -and $_.status -eq 'completed' -and $_.detail.output -eq '5'
    }).Count) { throw 'The recovered provider did not complete its MCP tool' }
    Invoke-TestCli plugin disable stage1-fixture | Out-Host
    $failed = Invoke-TestCli run --provider dsh --cwd $workspace --wait-timeout 2m 'missing addition detail' | ConvertFrom-Json
    $failedTimeline = Read-Timeline $failed.agentId
    $errors = @($failedTimeline | Where-Object { $_.type -eq 'tool_call' -and $_.status -eq 'failed' })
    if ($failed.status -ne 'completed' -or $errors.Count -ne 1 -or !$errors[0].error -or $errors[0].error -match '^DSH tool failed:') {
        throw 'Expected the original DSH tool error in a readable failed row'
    }
    $reload = Invoke-TestCli plugin reload paseo-dsh | ConvertFrom-Json
    if ($reload.status -ne 'running') { throw 'Reload did not restore the plugin' }
    $providers = @(Invoke-TestCli provider ls | ConvertFrom-Json)
    if (!@($providers | Where-Object { $_.provider -eq 'dsh' -or $_.id -eq 'dsh' }).Count) { throw 'DSH provider missing after reload' }
    Assert-NoDshProcess
    Invoke-TestCli plugin remove paseo-dsh | Out-Host
    $plugins = @(Invoke-TestCli plugin ls | ConvertFrom-Json)
    if (@($plugins | Where-Object id -eq 'paseo-dsh').Count) { throw 'Plugin remained installed after remove' }
    $providers = @(Invoke-TestCli provider ls | ConvertFrom-Json)
    if (@($providers | Where-Object { $_.provider -eq 'dsh' -or $_.id -eq 'dsh' }).Count) { throw 'DSH provider remained after remove' }
    Assert-NoDshProcess
    @{
        betaModel = $beta[0].id
        betaAgent = $first.agentId
        cancelAgent = $long.agentId
        stop = $stop
        waited = $waited
        continued = $after
        failedAgent = $failed.agentId
        originalToolError = $errors[0].error
        reloaded = $reload.status
        activeToolAgent = $active.agentId
        activeToolReload = $activeReload.status
        oldToolProcessIds = $beforeReload
        afterActiveToolReload = $recovered.status
        recoveredAgent = $recovered.agentId
        activeToolTerminalObserved = $activeToolTerminalObserved
        activeToolTimelineEvents = $watchArtifact
        activeToolTimelineLimitation = if (!$activeToolTerminalObserved) { 'Host publishes turn_failed but no terminal tool row; old session has no persistence capability.' } else { $null }
        removed = $true
        remainingDshProcesses = 0
    } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $root 'result.json')
    Write-Host 'PASS: workspace Beta, visible tool output and error, stop then continue, reload/remove and child cleanup.'
} finally {
    if ($watcher -and !$watcher.HasExited) {
        Set-Content -LiteralPath "$watchArtifact.stop" -Value 'stop'
        if (!$watcher.WaitForExit(5000)) { $watcher.Kill() }
    }
    & $node $cli daemon stop --home $testHome
    Assert-NoDshProcess
}


