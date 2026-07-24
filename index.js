const https = require('https')
const http = require('http')
const urlMod = require('url')

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()

  if (req.method === 'POST' && req.url === '/download') return handleDownload(req, res)
  if (req.method === 'POST' && req.url === '/ig-download') return handleIgDownload(req, res)

  res.writeHead(404); res.end('not found')
})

function handleDownload(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    let videoUrl
    try { const data = JSON.parse(body); videoUrl = data.url; if (!videoUrl) throw 1 }
    catch (e) { return json(res, 400, { error: 'invalid request' }) }
    downloadStream(videoUrl, (err, src) => {
      if (err || !src) return json(res, 502, { error: err || 'failed' })
      const size = parseInt(src.headers['content-length'] || '0')
      if (size > 0 && size < 10000) { src.resume(); return json(res, 502, { error: 'too small' }) }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size || undefined })
      src.pipe(res)
    })
  })
}

function handleIgDownload(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    let url
    try { const data = JSON.parse(body); url = data.url; if (!url) throw 1 }
    catch (e) { return json(res, 400, { error: 'invalid request' }) }
    igParseAndDownload(url, (err, videoStream, info) => {
      if (err || !videoStream) return json(res, 502, { error: err || 'no video found' })
      const size = parseInt(videoStream.headers['content-length'] || '0')
      if (size > 0 && size < 10000) { videoStream.resume(); return json(res, 502, { error: 'too small' }) }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': size || undefined,
        'X-Ig-Title': encodeURIComponent(info?.title || ''),
        'X-Ig-Author': encodeURIComponent(info?.author || ''),
      })
      videoStream.pipe(res)
    })
  })
}

function igParseAndDownload(pageUrl, cb) {
  const m = pageUrl.match(/instagram\.com\/(p|reel|reels|tv)\/([^/?]+)/)
  const shortcode = m ? m[2] : ''
  if (!shortcode) return cb('invalid url')
  let info = {}

  igFetchJSON('/p/' + shortcode + '/?__a=1&__d=1', (err, data) => {
    if (!err && data) {
      const item = data?.items?.[0] || data?.graphql?.shortcode_media || data?.item || {}
      if (item.video_versions?.length) {
        const url = item.video_versions.sort((a,b)=>b.width-a.width)[0].url
        info.title = item.caption?.text || item.accessibility_caption || ''
        info.author = item.owner?.username || item.user?.username || ''
        return downloadStream(url.replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
      }
      const edges = item.edge_sidecar_to_children?.edges || item.carousel_media || []
      for (const e of edges) {
        const n = e.node || e
        if (n.video_versions?.length) {
          const url = n.video_versions.sort((a,b)=>b.width-a.width)[0].url
          return downloadStream(url.replace(/^http:/,'https:'), (e2, s) => cb(e2, s, info))
        }
      }
    }
    igFetchOembed(shortcode, (err2, oembed) => {
      if (!err2 && oembed) {
        info.title = oembed.title || ''
        info.author = oembed.author_name || ''
        const iframeSrc = (oembed.html || '').match(/src="([^"]+)"/)?.[1] || ''
        if (iframeSrc) {
          let iframeUrl = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc
          igFetchHTML(iframeUrl, (err3, html) => {
            if (!err3 && html) {
              const ogv = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i)
                || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"[^>]*>/i)
              if (ogv) return downloadStream(ogv[1].replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
              const vt = html.match(/<video[^>]+src="([^"]+)"[^>]*>/i)
              if (vt) return downloadStream(vt[1].replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
            }
            igFallback(shortcode, info, cb)
          })
          return
        }
      }
      igFallback(shortcode, info, cb)
    })
  })
}

function igFallback(shortcode, info, cb) {
  igFetchHTML('https://www.instagram.com/p/' + shortcode + '/embed/', (err, html) => {
    if (!err && html) {
      const ogv = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i)
        || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"[^>]*>/i)
      if (ogv) return downloadStream(ogv[1].replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
      const vt = html.match(/<video[^>]+src="([^"]+)"[^>]*>/i)
      if (vt) return downloadStream(vt[1].replace(/^http:/,'https:'), (e, s) => cb(e, s, info))
      const vi = html.match(/"video_versions":\[([\s\S]*?)\]/)
      if (vi) { try { const a = JSON.parse('[' + vi[1] + ']'); if (a[0]?.url) return downloadStream(a.sort((x,y)=>y.width-x.width)[0].url.replace(/^http:/,'https:'), (e, s) => cb(e, s, info)) } catch(e) {} }
    }
    igFetchHTML('https://www.instagram.com/p/' + shortcode + '/', (err2, html2) => {
      if (!err2 && html2) {
        const vi2 = html2.match(/"video_versions":\[([\s\S]*?)\]/)
        if (vi2) { try { const a = JSON.parse('[' + vi2[1] + ']'); if (a[0]?.url) return downloadStream(a.sort((x,y)=>y.width-x.width)[0].url.replace(/^http:/,'https:'), (e, s) => cb(e, s, info)) } catch(e) {} }
        const ld = html2.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
        if (ld) { try { const j = JSON.parse(ld[1]); if (j.video?.contentUrl) return downloadStream(j.video.contentUrl.replace(/^http:/,'https:'), (e, s) => cb(e, s, info)) } catch(e) {} }
      }
      cb('could not extract video URL')
    })
  })
}

function igFetchJSON(path, cb) {
  const r = https.get({ hostname: 'www.instagram.com', path, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 15000, rejectUnauthorized: false }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return cb('HTTP' + res.statusCode) }
    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { cb(null, JSON.parse(d)) } catch (e) { cb(e.message) } })
  })
  r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
}

function igFetchHTML(fullUrl, cb) {
  const p = urlMod.parse(fullUrl)
  const r = https.get({ hostname: p.hostname, path: p.path + (p.search || ''), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 15000, rejectUnauthorized: false }, (res) => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => cb(null, d))
  })
  r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
}

function igFetchOembed(shortcode, cb) {
  const r = https.get({ hostname: 'api.instagram.com', path: '/oembed?url=https://www.instagram.com/p/' + shortcode + '/&format=json', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000, rejectUnauthorized: false }, (res) => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { cb(null, JSON.parse(d)) } catch (e) { cb(e.message) } })
  })
  r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
}

function downloadStream(url, cb) { redirectDownload(url, 0, cb) }

function redirectDownload(url, depth, cb) {
  if (depth > 5) return cb('too many redirects')
  const p = urlMod.parse(url)
  const mod = p.protocol === 'http:' ? http : https
  const r = mod.get({ hostname: p.hostname, path: p.path + (p.search || ''), headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' }, timeout: 25000, rejectUnauthorized: false }, (res) => {
    const loc = res.headers.location
    if ([301,302,303,307,308].includes(res.statusCode) && loc) { res.resume(); return redirectDownload(loc.startsWith('http') ? loc : 'https://' + p.hostname + loc, depth + 1, cb) }
    if (res.statusCode !== 200) { res.resume(); return cb('HTTP' + res.statusCode) }
    cb(null, res)
  })
  r.on('error', cb); r.on('timeout', function() { r.destroy(); cb('timeout') })
}

function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }

const PORT = parseInt(process.env.PORT || '3000')
server.listen(PORT, () => console.log('relay running on ' + PORT))
