const { spawn } = require('child_process');
const bundledFfprobePath = require('ffprobe-static').path;

function resolveFfprobePath() {
  return String(process.env.FFPROBE_PATH || bundledFfprobePath || 'ffprobe');
}

function inspectVideo(filePath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,duration:format=duration',
      '-of', 'json',
      filePath,
    ];
    const child = spawn(resolveFfprobePath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(safeVideoError('VIDEO_VALIDATION_TIMEOUT', 'Video validation timed out.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(safeVideoError('FFPROBE_UNAVAILABLE', 'Video validation is not available on this server.'));
      } else {
        reject(safeVideoError('VIDEO_VALIDATION_FAILED', 'The video could not be validated.'));
      }
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(safeVideoError('INVALID_VIDEO', 'The video is corrupt or uses an unsupported codec.'));
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0];
        const durationSeconds = Number(stream?.duration || data.format?.duration || 0);
        if (!stream || !durationSeconds || !stream.width || !stream.height) {
          return reject(safeVideoError('EMPTY_VIDEO', 'The uploaded file does not contain a usable video stream.'));
        }
        return resolve({
          durationSeconds,
          width: Number(stream.width),
          height: Number(stream.height),
          codec: String(stream.codec_name || ''),
        });
      } catch {
        return reject(safeVideoError('INVALID_VIDEO', 'The video is corrupt or could not be read.'));
      }
    });
  });
}

function safeVideoError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code === 'FFPROBE_UNAVAILABLE' ? 503 : 400;
  return error;
}

module.exports = { inspectVideo, resolveFfprobePath, safeVideoError };
