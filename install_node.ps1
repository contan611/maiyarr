$ErrorActionPreference = "Continue"

if (Get-Command node -ErrorAction SilentlyContinue) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Node.js is already installed. You can run START_MAFIA_SERVER.bat now.", "Node.js")
  exit 0
}

$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
  Start-Process -FilePath $winget.Source -ArgumentList @("install", "--id", "OpenJS.NodeJS.LTS", "-e", "--accept-package-agreements", "--accept-source-agreements") -Wait
} else {
  Start-Process "https://nodejs.org/"
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("The Node.js download page has been opened. Install the LTS version, then run START_MAFIA_SERVER.bat.", "Node.js")
  exit 0
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Node.js was installed. Run START_MAFIA_SERVER.bat.", "Node.js")
} else {
  Start-Process "https://nodejs.org/"
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Node.js may need a new terminal or a restart. If START_MAFIA_SERVER.bat still says Node is missing, install Node.js LTS from the opened page.", "Node.js")
}
