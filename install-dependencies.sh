#!/bin/bash
echo "Checking for Python..."
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python not found! Please install Python from https://www.python.org/"
    exit 1
fi
echo "SUCCESS: Python found!"

echo "Upgrading pip..."
python3 -m pip install --upgrade pip

echo "Installing mpremote..."
python3 -m pip install mpremote

echo "Installing mpy-cross..."
python3 -m pip install mpy-cross

echo "Installing micropython-stdlib-stubs..."
python3 -m pip install micropython-stdlib-stubs

echo "SUCCESS: All dependencies installed!"
