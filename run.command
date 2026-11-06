#!/bin/bash

cd -- "$(dirname -- "$0")" || exit 1

if [ ! -x "venv/bin/python" ]; then
    echo "Verwrity's Python environment is missing. Run these commands in this folder:"
    echo "  python3 -m venv venv"
    echo "  venv/bin/python -m pip install -e ."
    echo
    read -r -p "Press Return to close this window. "
    exit 1
fi

echo "Starting Verwrity. Open http://127.0.0.1:8000 in your browser."
echo "Press Ctrl-C to stop the server."
venv/bin/python -u -m verwrity.web.app
verwrity_exit_code=$?

if [ "$verwrity_exit_code" -ne 0 ]; then
    echo
    read -r -p "Press Return to close this window. "
fi

exit "$verwrity_exit_code"
