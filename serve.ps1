# Serves the app on a random unused port (ES modules need a server, file:// won't work).
# serve.json (auto-loaded from this directory) sends Cache-Control: no-store for
# every file, so the browser never serves stale JS/CSS across runs.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

npx --yes serve -l $port .
