Write-Host "Checking for Python..."
$python = Get-Command python -ErrorAction SilentlyContinue
if (-Not $python) {
    Write-Host "ERROR: Python not found! Please install Python from https://www.python.org/"
    exit 1
}
Write-Host "SUCCESS: Python found!"

Write-Host "Upgrading pip..."
python -m pip install --upgrade pip

Write-Host "Installing mpremote..."
python -m pip install mpremote

Write-Host "Installing mpy-cross..."
python -m pip install mpy-cross

Write-Host "Installing micropython-stdlib-stubs..."
python -m pip install micropython-stdlib-stubs

Write-Host "SUCCESS: All dependencies installed!"
