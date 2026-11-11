@echo off
setlocal
pushd "%~dp0" || exit /b 1

python -u -c "import functools, http.server, webbrowser; http.server.SimpleHTTPRequestHandler.extensions_map['.mjs'] = 'text/javascript'; handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory='docs'); server = http.server.ThreadingHTTPServer(('127.0.0.1', 8001), handler); url = 'http://127.0.0.1:8001/'; print('Preview: ' + url); print('Press Ctrl+C to stop.'); webbrowser.open(url); server.serve_forever()"

if errorlevel 1 (
    popd
    echo Preview stopped or failed to start.
    pause
    exit /b 1
)
popd
