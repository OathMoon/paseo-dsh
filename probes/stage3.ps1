param([Parameter(Mandatory)][string]$PaseoCli)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cli = (Resolve-Path $PaseoCli).Path
$plugin = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dsh = (Resolve-Path (Join-Path $plugin '../deepseek-harness')).Path
$node = (Get-Command node.exe).Source
$root = Join-Path ([IO.Path]::GetTempPath()) "paseo-dsh-stage3-$([guid]::NewGuid().ToString('N'))"
$testHome = Join-Path $root 'paseo'
$workspace = Join-Path $root 'requested workspace'
$target = Join-Path $workspace 'approved-writes.txt'
$null = New-Item -ItemType Directory -Path $testHome,$workspace
Write-Host "Test artifacts: $root"
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$endpoint = "127.0.0.1:$($listener.LocalEndpoint.Port)"
$listener.Stop()

$fixture = Join-Path $dsh 'apps/cli/tests/profiles/acp/tests/fixtures/control-surface'
$adapter = Join-Path $root 'permission-adapter.ts'
$llmUri = [Uri]::new((Join-Path $dsh 'packages/llm/llm/lib/index.js')).AbsoluteUri
$adapterText = (Get-Content (Join-Path $fixture 'control-surface-llm.ts') -Raw).
    Replace("'@deepseek-ai/dsh-llm'", "'$llmUri'").
    Replace('mcp__fixture__add', 'permission_write').
    Replace("const callId = ToolCallId(userText.includes('cancel') ? 'control-cancel-add' : 'control-add')", "const callId = ToolCallId('approval-' + options.messages.length)").
    Replace("export const inject = ['llm']", "export const inject = ['llm', 'tools', 'approval']").
    Replace('export function apply(ctx: Context): void', 'function applyBase(ctx: Context): void')
$adapterText += @'

import { appendFile } from 'node:fs/promises'
export function apply(ctx: Context): void {
  applyBase(ctx)
  ctx.tools.register({
    name: 'permission_write',
    description: 'Append one marker only after a one-shot approval.',
    parameters: {
      a: { type: 'number', required: true },
      b: { type: 'number', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const outcome = await ctx.approval.request({
        agent: exec.agent, toolName: 'permission_write', callId: exec.callId, signal: exec.signal,
      })
      if (outcome !== 'allowed-once') throw new Error(outcome)
      if (exec.signal.aborted) throw new Error('cancelled')
      await appendFile(process.env.DSH_APPROVAL_TARGET, 'written\n')
      return 'written'
    },
  })
}
'@
Set-Content $adapter $adapterText
$modelUri = [Uri]::new($adapter).AbsoluteUri
$patch = Join-Path $root 'fixture.yml'
$configText = (Get-Content (Join-Path $fixture 'cordis.yml') -Raw).Replace('./control-surface-llm.ts', $modelUri)
$configText += "`n- id: approval`n  config:`n    policy: ask`n"
Set-Content $patch $configText
$config = @{
    version = 1; pluginsEnabled = $true
    features = @{ dictation = @{ enabled = $false }; voiceMode = @{ enabled = $false } }
    daemon = @{ listen = $endpoint; relay = @{ enabled = $false } }
    agents = @{ providers = @{ dsh = @{
        command = @($node, (Join-Path $dsh 'apps/cli/lib/bin.js'), '--profile', 'acp', '--patch', $patch)
        env = @{
            DSH_HOME = (Join-Path $root 'dsh'); DSH_AGENTS_HOME = (Join-Path $root 'agents')
            DSH_CONFORMANCE_PERSISTENCE_ROOT = (Join-Path $root 'sessions')
            DSH_APPROVAL_TARGET = $target; DSH_TELEMETRY_DISABLED = '1'
        }
    } } }
}
$config | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $testHome 'config.json')
function Invoke-TestCli { & $node $cli --host $endpoint --json @args }
function Wait-Status([string]$AgentId, [string]$Expected) {
    $state = Invoke-TestCli wait $AgentId --timeout 2m | ConvertFrom-Json
    if ($state.status -ne $Expected) { throw "Expected $Expected, got $($state | ConvertTo-Json -Compress)" }
}
function Assert-MarkerCount([int]$Expected) {
    $count = if (Test-Path $target) { @(Get-Content $target).Count } else { 0 }
    if ($count -ne $Expected) { throw "Expected $Expected approved writes, got $count" }
}

try {
    & $node $cli daemon start --home $testHome
    Invoke-TestCli plugin install $plugin | Out-Host
    $agent = Invoke-TestCli run --provider dsh --new-workspace local --cwd $workspace --title 'DSH approval fixture' --no-wait 'first approval' | ConvertFrom-Json
    Wait-Status $agent.agentId permission
    Assert-MarkerCount 0
    Invoke-TestCli permit ls | Set-Content (Join-Path $root 'pending-first.json')
    Invoke-TestCli permit deny $agent.agentId --all | Out-Host
    Wait-Status $agent.agentId idle
    Assert-MarkerCount 0
    Set-Content (Join-Path $root 'checks.jsonl') '{"check":"denied-without-write","passed":true}'

    Invoke-TestCli send $agent.agentId --no-wait 'second approval' | Out-Host
    Wait-Status $agent.agentId permission
    Assert-MarkerCount 0
    Invoke-TestCli permit allow $agent.agentId | Out-Host
    Wait-Status $agent.agentId idle
    Assert-MarkerCount 1
    Add-Content (Join-Path $root 'checks.jsonl') '{"check":"allowed-once-wrote-one-marker","passed":true}'

    Invoke-TestCli send $agent.agentId --no-wait 'third approval' | Out-Host
    Wait-Status $agent.agentId permission
    Assert-MarkerCount 1
    Invoke-TestCli permit deny $agent.agentId --all | Out-Host
    Wait-Status $agent.agentId idle
    Assert-MarkerCount 1
    Add-Content (Join-Path $root 'checks.jsonl') '{"check":"repeated-request-required-new-approval","passed":true}'

    Invoke-TestCli send $agent.agentId --no-wait 'approval then stop' | Out-Host
    Wait-Status $agent.agentId permission
    Invoke-TestCli stop $agent.agentId | Out-Host
    Wait-Status $agent.agentId idle
    Assert-MarkerCount 1
    $afterStop = @(Invoke-TestCli permit ls | ConvertFrom-Json | Where-Object agentId -eq $agent.agentId)
    if ($afterStop.Count -ne 0) { throw 'Paseo retained a pending permission after stop' }
    Add-Content (Join-Path $root 'checks.jsonl') '{"check":"stop-during-approval-settled","passed":true}'
    Invoke-TestCli send $agent.agentId --no-wait 'approval after stop' | Out-Host
    Wait-Status $agent.agentId permission
    Invoke-TestCli permit deny $agent.agentId --all | Out-Host
    Wait-Status $agent.agentId idle
    Assert-MarkerCount 1
    Add-Content (Join-Path $root 'checks.jsonl') '{"check":"next-turn-after-stop-completed","passed":true}'
    $session = @(Get-ChildItem (Join-Path $root 'sessions') -Recurse -Filter session.v4.jsonl |
        Where-Object { (Get-Content $_.FullName -Raw).Contains('first approval') })
    if ($session.Count -ne 1) { throw 'Expected all prompts in one DSH session' }
    $events = @(Get-Content $session[0].FullName | ForEach-Object { $_ | ConvertFrom-Json })
    $outcomes = @($events | Where-Object type -eq 'approval/decided' | ForEach-Object { $_.data.outcome })
    if (($outcomes -join ',') -ne 'rejected,allowed-once,rejected,cancelled,rejected') {
        throw "Unexpected DSH approval audit: $($outcomes -join ',')"
    }
    $pending = @(Invoke-TestCli permit ls | ConvertFrom-Json | Where-Object agentId -eq $agent.agentId)
    if ($pending.Count -ne 0) { throw 'Paseo retained pending permissions after all turns settled' }
    Add-Content (Join-Path $root 'checks.jsonl') '{"check":"audit-outcomes-and-no-pending-permissions","passed":true}'
    & $node $cli --host $endpoint logs $agent.agentId | Set-Content (Join-Path $root 'transcript.txt')
    Invoke-TestCli send $agent.agentId --no-wait 'approval then reload' | Out-Host
    Wait-Status $agent.agentId permission
    $beforeReload = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($patch)
    } | Select-Object -ExpandProperty ProcessId)
    if (!$beforeReload.Count) { throw 'No active DSH process before reload' }
    $reloaded = Invoke-TestCli plugin reload paseo-dsh | ConvertFrom-Json
    if ($reloaded.status -ne 'running') { throw 'Plugin did not return after reload during approval' }
    $pendingAfterReload = @(Invoke-TestCli permit ls | ConvertFrom-Json | Where-Object agentId -eq $agent.agentId)
    if ($pendingAfterReload.Count) { throw 'Reload left an orphaned approval' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $remaining = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -in $beforeReload
        })
        if (!$remaining.Count) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count) { throw 'Reload left test DSH processes running' }
    $afterReloadEvents = @(Get-Content $session[0].FullName | ForEach-Object { $_ | ConvertFrom-Json })
    $lastDecision = @($afterReloadEvents | Where-Object type -eq 'approval/decided')[-1]
    if ($lastDecision.data.outcome -ne 'cancelled') { throw 'Reload did not cancel the DSH approval' }
    Assert-MarkerCount 1
    Add-Content (Join-Path $root 'checks.jsonl') '{"check":"reload-during-approval-cleared-permission-and-processes","passed":true}'
    Write-Host 'PASS: denied without write, allowed exactly once, repeated approval required, stopped approval released, next turn usable.'
} finally {
    & $node $cli daemon stop --home $testHome
}
