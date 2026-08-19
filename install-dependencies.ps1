Write-Host "Checking for Python..."
$pythonCommand = $null
$pythonPrefixArgs = @()

if (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonCommand = "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $pythonCommand = "py"
    $pythonPrefixArgs = @("-3")
}

if (-Not $pythonCommand) {
    Write-Host "ERROR: Python not found! Please install Python from https://www.python.org/"
    exit 1
}
Write-Host "SUCCESS: Python found: $pythonCommand $($pythonPrefixArgs -join ' ')"

Write-Host "Upgrading pip..."
& $pythonCommand @pythonPrefixArgs -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Installing mpremote..."
& $pythonCommand @pythonPrefixArgs -m pip install --upgrade mpremote
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Installing mpy-cross..."
& $pythonCommand @pythonPrefixArgs -m pip install --upgrade mpy-cross
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Installing micropython-stdlib-stubs..."
& $pythonCommand @pythonPrefixArgs -m pip install --upgrade micropython-stdlib-stubs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "SUCCESS: All dependencies installed!"
