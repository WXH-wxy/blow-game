# Minimal static file server (fallback when node/python is unavailable)
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path  # serve the script's own folder
$port = 8123

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$port/"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.AbsolutePath.TrimStart('/')
    Write-Host ("REQ: " + $req.Url.AbsolutePath)
    if ($path -eq '') { $path = 'index.html' }
    $full = Join-Path $root $path
    if (Test-Path $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full)
      $mime = switch ($ext) {
        '.html' { 'text/html; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.js'   { 'application/javascript; charset=utf-8' }
        '.png'  { 'image/png' }
        '.json' { 'application/json' }
        default { 'application/octet-stream' }
      }
      $res.ContentType = $mime
      $res.ContentLength64 = $bytes.Length
      $res.Headers.Add('Cache-Control', 'no-store')
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
  } catch {
    # ignore per-request errors, keep serving
  } finally {
    try { $res.Close() } catch {}
  }
}
