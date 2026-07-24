const https = require('https')
const http = require('http')
const urlMod = require('url')

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()

  // === POST /download — TikTok 视频中转 ===
  if (req.method === 'POST' && req.url === '/download') {
    return handleDownload(req, res)
  }

  // === POST /ig-download — Instagram 视频解析+下载 ===
  if (req.method === 'POST' && req.url === '/ig-download') {
    return handleIgDownload(req, res)
  }

  res.writeHead(404); res.end('not found')
})

// ========== TikTok 视频下载 ==========

function handleDownload(req, res) {
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

    downloadStream(videoUrl, (err, src) => {
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
}

// ========== Instagram 解析+下载 ==========

function handleIgDownload(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    let url
    try {
      const data = JSON.parse(body)
      url = data.url
      if (!url) throw new Error('no url')
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid request' }))
    }

    parseIgVideoUrl(url, (err, videoUrl, info) => {
      if (err || !videoUrl) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: err || 'no video found' }))
      }

      // 下载视频并流回
      downloadStream(videoUrl, (dlerr, src) => {
        if (dlerr || !src) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: dlerr || 'download failed' }))
        }
        const size = parseInt(src.headers['content-length'] || '0')
        if (size > 0 && size < 10000) {
          src.resume()
          res.writeHead(502, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'too small' }))
        }
        // 返回视频 + 元信息header
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': size || undefined,
          'X-Ig-Title': encodeURIComponent(info?.title || ''),
          'X-Ig-Author': encodeURIComponent(info?.author || ''),
          'Cache-Control': 'public, max-age=86400'
        })
        src.pipe(res)
      })
    })
  })
}

function parseIgVideoUrl(pageUrl, cb) {
  // 提取 shortcode
  const sc = pageUrl.match(/instagram\.com\/(p|reel|reels|tv)\/([^/?]+)/)
  const shortcode = sc ? sc[2] : ''
  if (!shortcode) return cb('invalid Instagram URL')

  let info = {}
  let videoUrl = null
  let attempts = 0
  const MAX_ATTEMPTS = 5

  // 策略1: oEmbed API 获取 embed HTML
  function tryOEmbed() {
    attempts++
    https.get({
      hostname: 'api.instagram.com',
      path: '/oembed?url=https://www.instagram.com/p/' + shortcode + '/&format=json',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const oembed = JSON.parse(d)
          info.title = oembed.title || ''
          info.author = oembed.author_name || ''
        } catch (e) {}
        tryGraphql()
      })
    }).on('error', () => tryGraphql()).on('timeout', function () { tryGraphql() })
  }

  const USER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': 'ig_did=60B7B4F2-8A3C-4B1E-9D5F-2A1C3E5F7G9H'
  }

  // 策略2: public graphql API (?__a=1)
  function tryGraphql() {
    if (attempts > MAX_ATTEMPTS) return done()
    attempts++
    https.get({
      hostname: 'www.instagram.com',
      path: '/p/' + shortcode + '/?__a=1&__d=1',
      headers: USER_HEADERS,
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      if ([301,302].includes(res.statusCode)) { res.resume(); return tryEmbedPage() }
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(d)
          const item = json?.items?.[0] || json?.graphql?.shortcode_media || json?.item || {}
          if (item.video_versions?.length) {
            videoUrl = item.video_versions.sort((a,b)=>b.width-a.width)[0].url
            info.title = item.caption?.text || item.accessibility_caption || info.title
            info.author = item.owner?.username || item.user?.username || info.author
            return done()
          }
          // carousel
          const edges = item.edge_sidecar_to_children?.edges || item.carousel_media || []
          for (const e of edges) {
            const node = e.node || e
            if (node.video_versions?.length) {
              videoUrl = node.video_versions.sort((a,b)=>b.width-a.width)[0].url
              return done()
            }
          }
        } catch (e) {}
        tryEmbedPage()
      })
    }).on('error', () => tryEmbedPage()).on('timeout', function () { tryEmbedPage() })
  }

  // 策略3: embed 页面提取 og:video
  function tryEmbedPage() {
    if (attempts > MAX_ATTEMPTS) return done()
    attempts++
    https.get({
      hostname: 'www.instagram.com',
      path: '/p/' + shortcode + '/embed/',
      headers: USER_HEADERS,
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      if ([301,302,303].includes(res.statusCode)) { res.resume(); return done() }
      let html = ''
      res.on('data', c => html += c)
      res.on('end', () => {
        const ogv = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i) ||
                    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"[^>]*>/i)
        if (ogv) { videoUrl = ogv[1]; return done() }
        const vt = html.match(/<video[^>]+src="([^"]+)"[^>]*>/i)
        if (vt) { videoUrl = vt[1]; return done() }
        // 尝试从 window.__INITIAL_STATE__ 提取
        const ir = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/i)
        if (ir) {
          try {
            const s = JSON.parse(ir[1])
            const items = s?.items || s?.media?._items || []
            for (const item of items) {
              if (item.video_versions?.length) { videoUrl = item.video_versions.sort((a,b)=>b.width-a.width)[0].url; return done() }
              for (const ci of (item.carousel_media || [])) { if (ci.video_versions?.length) { videoUrl = ci.video_versions[0].url; return done() } }
            }
          } catch(e) {}
        }
        // 直接在 HTML 搜索 video_versions JSON
        const vvMatch = html.match(/"video_versions":\[([\s\S]*?)\],"([^"]+?)":/g)
        if (vvMatch) {
          for (const m of vvMatch) {
            try {
              const arr = JSON.parse(m.match(/:(\[.*\])/)[1])
              if (arr[0]?.url) { videoUrl = arr.sort((a,b)=>b.width-a.width)[0].url; return done() }
            } catch(e) {}
          }
        }
        done()
      })
    }).on('error', () => done()).on('timeout', function () { done() })
  }

  function done() {
    if (videoUrl) {
      videoUrl = videoUrl.replace(/^http:/, 'https:')
      cb(null, videoUrl, info)
    } else {
      cb('could not extract video URL')
    }
  }

  // 先试 oEmbed，因为我们已有 Railway 环境，可以访问 api.instagram.com
  tryOEmbed()
}

// ========== 公共下载 ==========

function downloadStream(url, cb) {
  downloadWithRedirect(url, 0, cb)
}

function downloadWithRedirect(url, depth, cb) {
  if (depth > 5) return cb('too many redirects')
  const p = urlMod.parse(url)
  const mod = p.protocol === 'http:' ? http : https
  mod.get({
    hostname: p.hostname, path: p.path + (p.search || ''),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.instagram.com/'
    },
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
