# Small local web server, so the app can be opened at http://localhost:8000
# (the camera and the AI model do not work when index.html is double-clicked).
# Started by start.bat. Close the window to stop it.

$port = 8000
$root = $PSScriptRoot

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".json" = "application/json"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".bin"  = "application/octet-stream"
  ".txt"  = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Crop Health Monitor is running at http://localhost:$port"
Write-Host "Keep this window open. Close it to stop."

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $response = $context.Response
  try {
    $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($path -eq "/") { $path = "/index.html" }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart("/")))

    # Only serve files that are inside this folder.
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $type = $types[[IO.Path]::GetExtension($file).ToLower()]
      if (-not $type) { $type = "application/octet-stream" }
      $response.ContentType = $type
      $response.Headers.Add("Cache-Control", "no-cache")
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
    }
  } catch {
    $response.StatusCode = 500
  } finally {
    $response.Close()
  }
}
