param([Parameter(Mandatory)][string]$PaseoCli)
# Run with PowerShell 7 and the bin/paseo file of the Paseo CLI under test.
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
# Inject the fixture through session/new so DSH awaits the MCP mount before session.ready.
$fixturePlugin = Join-Path $root 'fixture-plugin'
$null = New-Item -ItemType Directory -Path $fixturePlugin
Set-Content (Join-Path $fixturePlugin 'paseo-plugin.json') '{"id":"stage1-fixture","requirements":{"paseo":"*"}}'
@"
export default function contribute(server) {
  server.addHook("agent.open.before", ({ request }) => {
    if (request.provider !== "dsh") return;
    return { ...request, mcpServers: { ...request.mcpServers, fixture: {
      type: "stdio", command: $(ConvertTo-Json $node -Compress), args: [$(ConvertTo-Json $serverPath -Compress)]
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

try {
    & $node $cli daemon start --home $testHome
    Invoke-TestCli plugin install $fixturePlugin | Out-Host
    Invoke-TestCli plugin install $plugin | Out-Host
    Invoke-TestCli plugin ls | Out-Host
    $first = Invoke-TestCli run --provider dsh --new-workspace local --cwd $workspace --title 'DSH stage 1' --wait-timeout 2m 'first addition' | ConvertFrom-Json
    $first | Out-Host
    if ($first.status -ne 'completed' -or $first.cwd -ne $workspace) { throw 'First turn or workspace mismatch' }
    $second = Invoke-TestCli send $first.agentId 'second addition' | ConvertFrom-Json
    $second | Out-Host
    if ($second.status -ne 'completed') { throw 'Second turn did not complete' }
    $transcript = (& $node $cli --host $endpoint logs $first.agentId --filter text) -join [Environment]::NewLine
    Set-Content (Join-Path $root 'transcript.txt') $transcript
    if ([regex]::Matches($transcript, 'model=alpha; tool=5').Count -ne 2) { throw "Unexpected transcript: $transcript" }
    $logs = @(Get-ChildItem (Join-Path $root 'sessions') -Filter session.v4.jsonl -Recurse |
        Where-Object { $body = Get-Content $_ -Raw; $body.Contains('first addition') -and $body.Contains('second addition') })
    if ($logs.Count -ne 1 -or ((Get-Content $logs[0] -TotalCount 1 | ConvertFrom-Json).cwd -ne $workspace)) {
        throw 'Expected both prompts in one DSH session in the requested workspace'
    }
    $results = @(Get-Content $logs[0] | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object type -eq 'tool/result')
    if ($results.Count -ne 2 -or @($results | Where-Object { $_.data.message.isError -or $_.data.message.content[0].text -ne '5' }).Count) {
        throw 'Expected two successful additions in the DSH log'
    }
    # A missing tool used to invalidate fetch_agent_timeline_response for the whole conversation.
    Invoke-TestCli plugin disable stage1-fixture | Out-Host
    $withoutTool = Invoke-TestCli run --provider dsh --cwd $workspace --title 'DSH failed tool' --wait-timeout 2m 'missing addition' | ConvertFrom-Json
    $failedTranscript = (& $node $cli --host $endpoint logs $withoutTool.agentId) -join [Environment]::NewLine
    Set-Content (Join-Path $root 'failed-tool.txt') $failedTranscript
    if ($withoutTool.status -ne 'completed' -or $failedTranscript -notmatch 'model=alpha; tool=5') {
        throw 'A failed tool prevented the assistant reply from being read'
    }
    $failedLog = Get-ChildItem (Join-Path $root 'sessions') -Recurse -Filter session.v4.jsonl |
        Where-Object { (Get-Content $_ -Raw).Contains('missing addition') }
    $errors = @(Get-Content $failedLog | ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.type -eq 'tool/result' -and $_.data.message.isError })
    if ($errors.Count -ne 1) { throw 'Expected one real DSH tool failure' }
    Write-Host 'PASS: two completed turns, two timeline replies, one DSH session in the requested workspace.'
} finally {
    & $node $cli daemon stop --home $testHome
}


