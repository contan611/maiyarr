$ErrorActionPreference = "SilentlyContinue"
$Port = 8787
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $Node) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Node.js is required on the computer that runs the server. Run INSTALL_NODE.bat first, then run START_MAFIA_SERVER.bat again.", "Mafia Server")
  exit 1
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
}

try {
  $ruleName = "Mafia Server $Port"
  $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if (-not $existingRule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private,Domain | Out-Null
  }
} catch {}

Start-Sleep -Milliseconds 500
Start-Process -FilePath $Node -ArgumentList "server.js" -WorkingDirectory $Root -WindowStyle Hidden

$ready = $false
for ($i = 0; $i -lt 35; $i++) {
  Start-Sleep -Milliseconds 200
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 1
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
}

if (-not $ready) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("The server did not start. Run START_MAFIA_SERVER.bat again.", "Mafia Server")
  exit 1
}

$lanIp = ""
try {
  $lanIp = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -First 1 -ExpandProperty IPAddress
} catch {}

$localUrl = "http://127.0.0.1:$Port"
$lanUrl = if ($lanIp) { "http://${lanIp}:$Port" } else { "" }
$addressText = Join-Path $Root "CONNECT_ADDRESS.txt"
$addressHtml = Join-Path $Root "CONNECT_ADDRESS.html"

@(
  "Mafia Server is running.",
  "",
  "Open on this server computer:",
  $localUrl,
  "",
  "Open on other phones / tablets / computers on the same Wi-Fi:",
  $(if ($lanUrl) { $lanUrl } else { "No Wi-Fi address found. Check the network connection." }),
  "",
  "How to use:",
  "1. Run START_MAFIA_SERVER.bat on one Windows computer.",
  "2. Connect every device to the same Wi-Fi or hotspot.",
  "3. Open the other-device address above in Safari, Chrome, or Edge.",
  "4. Create a room and share the room code or invite link.",
  "",
  "To stop the server, run STOP_MAFIA_SERVER.bat."
) | Set-Content -Encoding UTF8 $addressText

$qrUrl = if ($lanUrl) { "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=$([uri]::EscapeDataString($lanUrl))" } else { "" }
$qrMarkup = if ($qrUrl) { "<img src='$qrUrl' alt='QR code'>" } else { "<p class='muted'>No Wi-Fi address was found.</p>" }
$html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mafia Connection</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #111315; color: #f2f5f2; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 18px; }
    .card { background: #191d21; border: 1px solid #343c40; border-radius: 10px; padding: 22px; margin-bottom: 16px; }
    h1 { margin: 0 0 10px; font-size: 32px; }
    h2 { margin: 0 0 12px; font-size: 18px; color: #a9b3ad; }
    a { color: #2fb98e; font-size: 24px; font-weight: 800; word-break: break-all; }
    p, li { line-height: 1.55; color: #c9d1cc; }
    img { background: white; padding: 10px; border-radius: 8px; margin-top: 12px; }
    button { border: 0; border-radius: 8px; padding: 12px 14px; background: #2fb98e; color: #081411; font-weight: 800; cursor: pointer; }
    .muted { color: #a9b3ad; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Mafia Server is running</h1>
      <p>Use the address below on phones, tablets, and other computers.</p>
    </div>
    <div class="card">
      <h2>Other device address</h2>
      <a href="$lanUrl">$lanUrl</a>
      <p><button onclick="navigator.clipboard.writeText('$lanUrl')">Copy address</button></p>
      $qrMarkup
    </div>
    <div class="card">
      <h2>This computer</h2>
      <a href="$localUrl">$localUrl</a>
    </div>
    <div class="card">
      <h2>If it does not work</h2>
      <ol>
        <li>Connect every device to the same Wi-Fi or hotspot.</li>
        <li>Allow Node.js in Windows Firewall.</li>
        <li>If school Wi-Fi blocks device-to-device access, use one phone hotspot for all devices.</li>
        <li>If the server computer sleeps or turns off, the game stops.</li>
      </ol>
    </div>
  </main>
</body>
</html>
"@
$html | Set-Content -Encoding UTF8 $addressHtml

Start-Process $localUrl
Start-Process $addressHtml
