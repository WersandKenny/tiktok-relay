const https = require('https')
const http = require('http')
const urlMod = require('url')

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok' })) }
  if (req.method === 'POST' && req.url === '/download') return handleDownload(req, res)
  if (req.method === 'POST' && req.url === '/ig-download') return handleIgDownload(req, res)
  res.writeHead(404); res.end('not found')
}).on('error', e => console.error('server error:', e))

function handleDownload(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    try {
      const data = JSON.parse(body)
      if (!data.url) throw new Error('no url')
      downloadStream(data.url, (err, src) => {
        if (err || !src) return sendJson(res, 502, { error: err || 'failed' })
        const size = parseInt(src.headers['content-length'] || '0')
        if (size > 0 && size < 10000) { src.resume(); return sendJson(res, 502, { error: 'too small' }) }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size || undefined })
        src.pipe(res)
      })
    } catch (e) { sendJson(res, 400, { error: e.message }) }
  })
}

function handleIgDownload(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    try {
      const data = JSON.parse(body)
      if (!data.url) throw new Error('no url')
      igParseAndDownload(data.url, (err, videoStream, info) => {
        if (err || !videoStream) return sendJson(res, 502, { error: err || 'no video' })
        const size = parseInt(videoStream.headers['content-length'] || '0')
        if (size > 0 && size < 10000) { videoStream.resume(); return sendJson(res, 502, { error: 'too small' }) }
        const h = { 'Content-Type': 'video/mp4', 'Content-Length': size || undefined }
        if (info?.title) h['X-Ig-Title'] = encodeURIComponent(info.title)
        if (info?.author) h['X-Ig-Author'] = encodeURIComponent(info.author)
        res.writeHead(200, h)
        videoStream.pipe(res)
      })
    } catch (e) { sendJson(res, 400, { error: e.message }) }
  })
}

function igParseAndDownload(pageUrl, cb) {
  const m = pageUrl.match(/instagram\.com\/(p|reel|reels|tv)\/([^/?]+)/)
  const sc = m ? m[2] : ''
  if (!sc) return cb('invalid url')
  let info = {}
  tryDdIg(sc, info, cb)
}

function tryDdIg(sc, info, cb) {
  igFetchHTML('https://www.ddinstagram.com/p/' + sc + '/', (err, html) => {
    if (err) return tryGraphql(sc, info, cb)
    const ogv = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"[^>]*>/i)
    if (ogv) {
      info.title = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"[^>]*>/i)?.[1] || ''
      info.author = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"[^>]*>/i)?.[1] || ''
      return downloadStream(ogv[1].replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
    }
    tryGraphql(sc, info, cb)
  })
}

function tryGraphql(sc, info, cb) {
  igFetchJSON('/p/' + sc + '/?__a=1', (err, data) => {
    if (err) return cb('could not extract video URL')
    try {
      const item = data?.items?.[0] || data?.graphql?.shortcode_media || data?.item || {}
      if (item.video_versions?.length) {
        const url = item.video_versions.sort((a,b)=>b.width-a.width)[0].url
        info.title = item.caption?.text || item.accessibility_caption || ''
        info.author = item.owner?.username || item.user?.username || ''
        return downloadStream(url.replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
      }
      for (const e of (item.edge_sidecar_to_children?.edges || item.carousel_media || [])) {
        const n = e.node || e
        if (n.video_versions?.length) {
          const url = n.video_versions.sort((a,b)=>b.width-a.width)[0].url
          return downloadStream(url.replace(/^http:/,'https:'), (e2, s) => cb(e2, s, info))
        }
      }
    } catch(e) {}
    cb('no video in this post')
  })
}

function igFetchJSON(path, cb) {
  const r = https.get({ hostname: 'www.instagram.com', path, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 15000, rejectUnauthorized: false }, (res) => {
    let d = ''
    res.on('data', c => d += c)
    res.on('end', () => {
      if (res.statusCode !== 200) return cb('HTTP' + res.statusCode)
      try { cb(null, JSON.parse(d)) } catch (e) { cb(e.message) }
    })
  })
  r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
}

function igFetchHTML(fullUrl, cb) {
  try {
    const p = urlMod.parse(fullUrl)
    const r = https.get({ hostname: p.hostname, path: p.path + (p.search || ''), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 15000, rejectUnauthorized: false }, (res) => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => cb(null, d))
    })
    r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
  } catch(e) { cb(e.message) }
}

function downloadStream(url, cb) { redirectDownload(url, 0, cb) }

function redirectDownload(url, depth, cb) {
  if (depth > 5) return cb('too many redirects')
  try {
    const p = urlMod.parse(url)
    const mod = p.protocol === 'http:' ? http : https
    const r = mod.get({ hostname: p.hostname, path: p.path + (p.search || ''), headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' }, timeout: 25000, rejectUnauthorized: false }, (res) => {
      const loc = res.headers.location
      if ([301,302,303,307,308].includes(res.statusCode) && loc) { res.resume(); return redirectDownload(loc.startsWith('http') ? loc : 'https://' + p.hostname + loc, depth + 1, cb) }
      if (res.statusCode !== 200) { res.resume(); return cb('HTTP' + res.statusCode) }
      cb(null, res)
    })
    r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
  } catch(e) { cb(e.message) }
}

function sendJson(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }

const PORT = parseInt(process.env.PORT || '3000')
server.listen(PORT, () => console.log('relay running on ' + PORT))
