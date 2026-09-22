# dpapi-helper.ps1 (T04) — the ONLY place plaintext credentials exist outside
# process memory. PowerShell 5.1, Windows DPAPI, CurrentUser scope.
#
# Contract:
#   protect : plaintext JSON arrives on STDIN (anonymous pipe); base64
#             ciphertext is written to STDOUT. Nothing is echoed.
#   reveal  : reads the base64 ciphertext blob file; plaintext JSON is
#             written to STDOUT only when stdout is a REDIRECTED PIPE and
#             the caller passed -ExpectPipe pipe (explicit mode/caller
#             expectation). An interactive console is refused.
#   Every failure exits nonzero with a fixed ERR:<code> token on stderr —
#   never paths, never content, never raw exception text (a PowerShell error
#   record could embed URLs containing the bot token).

param(
    [Parameter(Mandatory = $true)][ValidateSet('protect', 'reveal')][string]$Mode,
    [string]$BlobPath,
    [string]$ExpectPipe = ''
)

$ErrorActionPreference = 'Stop'

function Write-FixedError {
    param([string]$Code, [int]$Exit)
    [Console]::Error.WriteLine("ERR:$Code")
    exit $Exit
}

try {
    Add-Type -AssemblyName System.Security | Out-Null
} catch {
    Write-FixedError -Code 'dpapi_unavailable' -Exit 6
}

try {
    if ($Mode -eq 'protect') {
        $stdin = [Console]::OpenStandardInput()
        $buffer = New-Object byte[] 4096
        $memory = New-Object System.IO.MemoryStream
        while (($read = $stdin.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $memory.Write($buffer, 0, $read)
        }
        $plain = $memory.ToArray()
        $memory.Dispose()
        if ($plain.Length -eq 0) { Write-FixedError -Code 'empty_input' -Exit 3 }
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $plain.Clear()
        [Console]::Out.Write([Convert]::ToBase64String($encrypted))
        exit 0
    }

    # Mode = reveal
    if ($ExpectPipe -ne 'pipe') { Write-FixedError -Code 'mode_required' -Exit 4 }
    if ([Console]::IsOutputRedirected -ne $true) { Write-FixedError -Code 'tty_stdout_refused' -Exit 5 }
    $encoded = [System.IO.File]::ReadAllText($BlobPath).Trim()
    $cipher = [Convert]::FromBase64String($encoded)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::OpenStandardOutput().Write($plain, 0, $plain.Length)
    $plain.Clear()
    exit 0
} catch {
    # Catch-all: fixed code only. The raw exception may embed the blob path
    # or other local details and must never reach stderr.
    Write-FixedError -Code 'dpapi_failed' -Exit 1
}
