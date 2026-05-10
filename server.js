const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

function findBinary(names) {
  if (process.env.YTDLP_PATH && names.includes('yt-dlp')) return process.env.YTDLP_PATH;
  if (process.env.FFMPEG_PATH && names.includes('ffmpeg')) return process.env.FFMPEG_PATH;

  const localDir = __dirname;
  for (const name of names) {
    const localExe = process.platform === 'win32' ? name + '.exe' : name;
    const localPath = path.join(localDir, localExe);
    if (fs.existsSync(localPath)) return localPath;
  }
  for (const name of names) {
    const exe = process.platform === 'win32' ? name + '.exe' : name;
    const which = spawn(process.platform === 'win32' ? 'where' : 'which', [exe], { windowsHide: true });
    return new Promise((resolve) => {
      let out = '';
      which.stdout.on('data', d => { out += d; });
      which.on('close', code => {
        if (code === 0 && out.trim()) resolve(out.trim().split('\n')[0].trim());
        else resolve(exe);
      });
      which.on('error', () => resolve(exe));
    });
  }
}

async function init() {
  const ytdlp = await findBinary(['yt-dlp', 'youtube-dl']);
  const ffmpeg = await findBinary(['ffmpeg']);
  return { YTDLP: ytdlp, FFMPEG: ffmpeg };
}

function runYtDlp(ytdlp, ffmpeg, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const opts = { windowsHide: true };
    const proc = spawn(ytdlp, args, opts);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Request timed out'));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || 'yt-dlp exited with code ' + code).slice(0, 500)));
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error('Failed to run yt-dlp: ' + err.message));
    });
  });
}

function parseSize(bytes) {
  const n = parseInt(bytes);
  if (!n) return '';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/api/info', async (req, res) => {
  try {
    const { YTDLP, FFMPEG } = await init();
    const { url } = req.body;
    if (!url || (!url.includes('youtube.com/') && !url.includes('youtu.be/'))) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const output = await runYtDlp(YTDLP, FFMPEG, ['--dump-json', '--no-playlist', url]);
    const info = JSON.parse(output);

    const availableResolutions = new Set();
    const combinedFormats = [];

    for (const f of (info.formats || [])) {
      if (f.vcodec !== 'none' && f.acodec !== 'none') {
        const height = f.height || 0;
        const key = height + '_' + (f.fps || 0);
        if (!availableResolutions.has(key)) {
          availableResolutions.add(key);
          combinedFormats.push({
            format_id: f.format_id,
            quality: f.resolution || f.format_note || f.format,
            ext: f.ext,
            fps: f.fps,
            size: parseSize(f.filesize || f.filesize_approx),
            height,
            hasAudio: true,
            isMerged: false,
          });
        }
      }
    }

    combinedFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

    const videoFmts = [];
    const seenV = new Set();
    for (const f of (info.formats || [])) {
      if (f.vcodec !== 'none' && f.resolution !== 'audio only') {
        const key = (f.height || 0) + '_' + (f.fps || 0);
        if (!seenV.has(key)) {
          seenV.add(key);
          videoFmts.push(f);
        }
      }
    }

    const hasAudioStream = (info.formats || []).some(f => f.acodec !== 'none' && f.vcodec === 'none');
    const maxVideoHeight = videoFmts.length ? Math.max(...videoFmts.map(f => f.height || 0)) : 0;

    const qualityTiers = [];
    if (maxVideoHeight > 0 && hasAudioStream) {
      const heights = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];
      for (const h of heights) {
        if (h <= maxVideoHeight) {
          qualityTiers.push({
            format_selector: 'bestvideo[height<=' + h + ']+bestaudio/best[height<=' + h + ']/best',
            quality: h + 'p' + (h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h === 1080 ? ' (Full HD)' : h === 720 ? ' (HD)' : ''),
            hasAudio: true,
            isMerged: true,
            height: h,
          });
        }
      }
    }

    res.json({
      title: info.title,
      author: info.uploader || info.channel || 'Unknown',
      duration: info.duration || 0,
      views: info.view_count || 0,
      thumbnails: (info.thumbnails || []).map(t => ({ url: t.url, width: t.width, height: t.height })),
      combinedFormats,
      mergedTiers: qualityTiers,
    });
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({ error: 'Could not fetch video info. ' + error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { YTDLP, FFMPEG } = await init();
    const { url, format_id, format_selector } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Missing URL' });
    }

    const fmt = format_selector || format_id || 'bestvideo+bestaudio/best';

    const infoOutput = await runYtDlp(YTDLP, FFMPEG, ['--dump-json', '--no-playlist', url]);
    const info = JSON.parse(infoOutput);

    const safeTitle = (info.title || 'video').replace(/[<>:"/\\|?*]/g, '').trim();
    let ext = 'mp4';

    if (format_selector) {
      ext = 'mkv';
    } else if (format_id) {
      const f = (info.formats || []).find(x => x.format_id === format_id);
      ext = f ? f.ext : 'mp4';
    }

    const filename = encodeURIComponent(safeTitle + '.' + ext);

    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + filename);
    res.setHeader('Content-Type', 'application/octet-stream');

    const args = [
      '-f', fmt, '-o', '-', '--no-playlist',
      '--ffmpeg-location', FFMPEG,
      url,
    ];

    const proc = spawn(YTDLP, args, { windowsHide: true });

    let hasOutput = false;
    proc.stdout.on('data', () => { hasOutput = true; });
    proc.stderr.on('data', d => { process.stderr.write(d); });

    proc.on('error', err => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed: ' + err.message });
      }
    });

    proc.stdout.pipe(res);

    proc.on('close', code => {
      if (code !== 0) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed with code ' + code });
        } else if (!hasOutput) {
          res.end();
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
    });
  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed: ' + error.message });
    }
  }
});

init().then(({ YTDLP }) => {
  app.listen(PORT, () => {
    console.log('Server running at http://localhost:' + PORT);
    console.log('yt-dlp: ' + YTDLP);
  });
}).catch(err => {
  console.error('Failed to initialize:', err.message);
  app.listen(PORT, () => {
    console.log('Server running (with errors) at http://localhost:' + PORT);
  });
});
