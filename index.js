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
  const sc = pageUrl.match(/instagram\.com\/(p|reel|reels|tv)\/([^/?]+)/)
  const shortcode = sc ? sc[2] : ''
  if (!shortcode) return cb('invalid Instagram URL')

  let info = {}
  let videoUrl = null
  let debug = []
  let attempts = 0
  const MAX_A = 6

  function log(m) { debug.push(m) }

  // 策略1: oEmbed → 获取 thumbnail_url 及 embed iframe URL
  function tryOEmbed() {
    attempts++; log('1:oEmbed')
    https.get({
      hostname: 'api.instagram.com',
      path: '/oembed?url=https://www.instagram.com/p/' + shortcode + '/&format=json',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const o = JSON.parse(d)
          info.title = o.title || ''
          info.author = o.author_name || ''
          // 从 embed html 提取 iframe src
          const iframe = o.html?.match(/src="([^"]+)"/)?.[1] || ''
          log('oembed ok, title=' + info.title + ', iframe=' + (iframe ? 'yes' : 'no'))
          // 如果有 iframe URL，直接获取该页面
          if (iframe) { tryIframePage(iframe); return }
        } catch (e) { log('oembed parse fail: ' + e.message) }
        // oEmbed 没拿到 iframe，尝试别的
        tryCdnImage(o.thumbnail_url || '')
      })
    }).on('error', e => { log('oembed err: ' + e.message); tryGraphql() })
      .on('timeout', function () { log('oembed timeout'); tryGraphql() })
  }

  // 策略2: 从 oEmbed 的 iframe 页面提取 og:video
  function tryIframePage(iframeUrl) {
    if (attempts > MAX_A) return done()
    attempts++; log('2:iframe')
    const iu = new URL(iframeUrl)
    https.get({
      hostname: iu.hostname, path: iu.pathname + iu.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      if ([301,302,303].includes(res.statusCode)) { res.resume(); log('iframe redirect to ' + res.headers.location); tryGraphql(); return }
      let h = ''; res.on('data', c => h += c)
      res.on('end', () => {
        const ogv = h.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i) || h.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"[^>]*>/i)
        if (ogv) { videoUrl = ogv[1]; return done() }
        log('no og:video in iframe page')
        // 搜索 video_versions
        const vi = h.match(/"video_versions":\[([\s\S]*?)\]/)
        if (vi) {
          try { const arr = JSON.parse('[' + vi[1] + ']'); if (arr[0]?.url) { videoUrl = arr.sort((a,b)=>b.width-a.width)[0].url; return done() } } catch(e) {}
        }
        tryCdnImage('')
      })
    }).on('error', e => { log('iframe err: ' + e.message); tryGraphql() })
      .on('timeout', function () { log('iframe timeout'); tryGraphql() })
  }

  // 策略3: 尝试从 Instagram CDN 的 og:image 推测视频URL
  function tryCdnImage(thumbUrl) {
    if (attempts > MAX_A) return done()
    attempts++; log('3:graphql')
    const USER_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    }
    https.get({
      hostname: 'www.instagram.com',
      path: '/p/' + shortcode + '/?__a=1&__d=1',
      headers: USER_HEADERS, timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      if ([301,302].includes(res.statusCode)) { res.resume(); log('graphql redirect to ' + res.headers.location); tryEmbedPage(); return }
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          const item = j?.items?.[0] || j?.graphql?.shortcode_media || j?.item || {}
          if (item.video_versions?.length) {
            videoUrl = item.video_versions.sort((a,b)=>b.width-a.width)[0].url; return done()
          }
          const edges = item.edge_sidecar_to_children?.edges || item.carousel_media || []
          for (const e of edges) {
            const n = e.node || e
            if (n.video_versions?.length) { videoUrl = n.video_versions.sort((a,b)=>b.width-a.width)[0].url; return done() }
          }
          log('graphql no video')
        } catch (e) { log('graphql parse: ' + e.message) }
        tryEmbedPage()
      })
    }).on('error', e => { log('graphql err: ' + e.message); tryEmbedPage() })
      .on('timeout', function () { log('graphql timeout'); tryEmbedPage() })
  }

  // 策略4: embed 页面
  function tryEmbedPage() {
    if (attempts > MAX_A) return done()
    attempts++; log('4:embed')
    https.get({
      hostname: 'www.instagram.com',
      path: '/p/' + shortcode + '/embed/',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      if ([301,302,303].includes(res.statusCode)) { res.resume(); log('embed redirect to ' + res.headers.location); tryJsonLd(); return }
      let h = ''; res.on('data', c => h += c)
      res.on('end', () => {
        const ogv = h.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i) || h.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"[^>]*>/i)
        if (ogv) { videoUrl = ogv[1]; return done() }
        const vt = h.match(/<video[^>]+src="([^"]+)"[^>]*>/i)
        if (vt) { videoUrl = vt[1]; return done() }
        const vi = h.match(/"video_versions":\[([\s\S]*?)\]/)
        if (vi) { try { const arr = JSON.parse('[' + vi[1] + ']'); if (arr[0]?.url) { videoUrl = arr.sort((a,b)=>b.width-a.width)[0].url; return done() } } catch(e) {} }
        log('embed no video, html=' + h.length + 'ch')
        tryJsonLd()
      })
    }).on('error', e => { log('embed err: ' + e.message); tryJsonLd() })
      .on('timeout', function () { log('embed timeout'); tryJsonLd() })
  }

  // 策略5: JSON-LD
  function tryJsonLd() {
    if (attempts > MAX_A) return done()
    attempts++; log('5:jsonld')
    https.get({
      hostname: 'www.instagram.com',
      path: '/p/' + shortcode + '/',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000, rejectUnauthorized: false
    }, (res) => {
      let crumbs = ''
      let h = ''
      res.on('data', c => { h += c; if (!crumbs && h.includes('"@type"')) { const m = h.match(/{[^}]*"@type"[^}]*}/); if (m) crumbs = m[0] } })
      res.on('end', () => {
        if (crumbs) {
          try {
            const ld = JSON.parse(crumbs)
            if (ld.video?.contentUrl) { videoUrl = ld.video.contentUrl; return done() }
          } catch(e) {}
        }
        log('jsonld fail, html=' + h.length + 'ch')
        done()
      })
    }).on('error', e => { log('jsonld err: ' + e.message); done() })
      .on('timeout', function () { log('jsonld timeout'); done() })
  }

  function done() {
    if (videoUrl) {
      videoUrl = videoUrl.replace(/^http:/, 'https:')
      cb(null, videoUrl, info)
    } else {
      cb('could not extract video URL', debug.join(' → '))
    }
  }

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
