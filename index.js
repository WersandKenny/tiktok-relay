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
  // 规范化 URL：兼容 /p/、/reel/、/reels/、/tv/
  const cleanUrl = pageUrl.replace(/\/\?.*$/, '').split('?')[0]

  fetchPage(cleanUrl, (err, html) => {
    if (err) return cb(err)

    let videoUrl = null
    let info = {}

    // 方法1: 从 JSON-LD script 标签提取
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1])
        if (ld.video) {
          videoUrl = ld.video.contentUrl || ld.video.embedUrl || null
          info.title = ld.video.name || ld.video.description || ''
          info.author = ld.video.author?.name || ''
        }
      } catch (e) {}
    }

    // 方法2: 从 window.__INITIAL_STATE__ 提取
    if (!videoUrl) {
      const irMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/)
      if (irMatch) {
        try {
          const state = JSON.parse(irMatch[1])
          const items = state?.items || state?.feed?.items || state?.media?.items || []
          for (const item of items) {
            const versions = item?.video_versions || []
            if (versions.length > 0) {
              videoUrl = versions.sort((a, b) => (b.width || 0) - (a.width || 0))[0].url
              info.title = item?.caption?.text || ''
              info.author = item?.user?.username || ''
              break
            }
            // carousel
            const carousel = item?.carousel_media || []
            for (const ci of carousel) {
              if (ci.media_type === 2) {
                const cv = ci.video_versions || []
                if (cv.length > 0) { videoUrl = cv[0].url; break }
              }
            }
            if (videoUrl) break
          }
          // 有时在短路径下
          if (!videoUrl && state?.media?.video_versions) {
            videoUrl = state.media.video_versions.sort((a, b) => (b.width || 0) - (a.width || 0))[0].url
          }
        } catch (e) {}
      }
    }

    // 方法3: 从 __NEXT_DATA__ (新版Instagram页面)
    if (!videoUrl) {
      const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
      if (ndMatch) {
        try {
          const next = JSON.parse(ndMatch[1])
          const pageProps = next?.props?.pageProps || {}
          const media = pageProps?.media || pageProps?.postInfo || {}
          const vv = media?.video_versions || []
          if (vv.length > 0) {
            videoUrl = vv.sort((a, b) => (b.width || 0) - (a.width || 0))[0].url
            info.title = media?.caption?.text || ''
            info.author = media?.user?.username || ''
          }
        } catch (e) {}
      }
    }

    // 方法4: 直接从 HTML 中搜索 video_url / video_versions 原始 JSON
    if (!videoUrl) {
      const jsonMatches = html.matchAll(/"video_versions":\[([\s\S]*?)\],"([^"]+?)":/g)
      for (const match of jsonMatches) {
        try {
          const arr = JSON.parse('[' + match[1] + ']')
          if (arr.length > 0 && arr[0].url) {
            videoUrl = arr.sort((a, b) => (b.width || 0) - (a.width || 0))[0].url
            break
          }
        } catch (e) {}
      }
    }

    if (videoUrl) {
      videoUrl = videoUrl.replace(/^http:/, 'https:')
      cb(null, videoUrl, info)
    } else {
      cb('could not extract video URL from page')
    }
  })
}

function fetchPage(url, cb) {
  const p = urlMod.parse(url)
  // 确保是 instagram.com
  const opts = {
    hostname: 'www.instagram.com',
    path: p.path + (p.search || ''),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'ig_did=60B7B4F2-8A3C-4B1E-9D5F-2A1C3E5F7G9H; ig_nrcb=1; mid=Z_X0QAALAAF0Y1cYxp48LqLxFmRp'
    },
    timeout: 20000,
    rejectUnauthorized: false
  }
  https.get(opts, (res) => {
    // 处理重定向
    if ([301, 302, 303].includes(res.statusCode) && res.headers.location) {
      res.resume()
      return cb('redirect: ' + res.headers.location)
    }
    let html = ''
    res.on('data', c => html += c)
    res.on('end', () => cb(null, html))
  }).on('error', cb).on('timeout', function () { cb('timeout') })
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
