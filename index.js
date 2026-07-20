const https = require('https')
const http = require('http')
const urlMod = require('url')

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()
  if (req.method !== 'POST' || req.url !== '/download') {
    res.writeHead(404); return res.end('not found')
  }

  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    let videoUrl
    try {
      const data = JSON.parse(body)
      videoUrl = data.url
      if (!videoUrl) throw new Error('no url')
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid request' }))
    }

    downloadWithRedirect(videoUrl, 0, (err, src) => {
      if (err || !src) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: err || 'download failed' }))
      }
      const size = parseInt(src.headers['content-length'] || '0')
      if (size > 0 && size < 10000) {
        src.resume()
        res.writeHead(502, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'too small' }))
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': size || undefined,
        'Cache-Control': 'public, max-age=86400'
      })
      src.pipe(res)
    })
  })
})

function downloadWithRedirect(url, depth, cb) {
  if (depth > 5) return cb('too many redirects')
  const p = urlMod.parse(url)
  https.get({
    hostname: p.hostname, path: p.path + (p.search || ''),
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' },
    timeout: 25000, rejectUnauthorized: false
  }, (res) => {
    const loc = res.headers.location
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
      res.resume()
      return downloadWithRedirect(
        loc.startsWith('http') ? loc : `https://${p.hostname}${loc}`,
        depth + 1, cb
      )
    }
    if (res.statusCode !== 200) { res.resume(); return cb('HTTP' + res.statusCode) }
    cb(null, res)
  }).on('error', cb).on('timeout', function () { cb('timeout') })
}

const PORT = parseInt(process.env.PORT || '3000')
server.listen(PORT, () => console.log('relay running on ' + PORT))
