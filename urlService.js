/* ============================================================
   URL Service — Fetches a URL and extracts readable text
   ============================================================ */

const http  = require('http');
const https = require('https');
const dns   = require('dns');
const { URL } = require('url');

class UrlService {
  constructor() {
    this.timeout    = 15000;
    this.maxBytes   = 2 * 1024 * 1024; // 2MB cap
  }

  async extractText(rawUrl) {
    // Normalise URL
    if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch (e) { throw new Error('Invalid URL: ' + rawUrl); }

    const hostname = parsed.hostname;
    const isHttps  = parsed.protocol === 'https:';

    // Resolve to IPv4 to avoid connection hangs
    const ip = await this._resolveIPv4(hostname);
    const path = parsed.pathname + parsed.search;

    const html = await this._fetch(ip, hostname, path, isHttps);
    const text = this._htmlToText(html);

    if (!text || text.trim().length < 50) {
      throw new Error('Could not extract enough readable text from that URL. Try a different page.');
    }
    return text.substring(0, 50000); // cap at 50k chars
  }

  // ── IPv4 resolver ────────────────────────────────────────
  _resolveIPv4(hostname) {
    return new Promise((resolve, reject) => {
      dns.resolve4(hostname, (err, addrs) => {
        if (err || !addrs || !addrs.length) {
          // fallback: try plain hostname
          resolve(hostname);
        } else {
          resolve(addrs[0]);
        }
      });
      setTimeout(() => resolve(hostname), 5000);
    });
  }

  // ── HTTP/S Fetcher ───────────────────────────────────────
  _fetch(ip, hostname, path, isHttps) {
    return new Promise((resolve, reject) => {
      const lib = isHttps ? https : http;
      const options = {
        host: ip,
        port: isHttps ? 443 : 80,
        path: path || '/',
        method: 'GET',
        ...(isHttps && ip !== hostname ? { servername: hostname } : {}),
        headers: {
          'Host': hostname,
          'User-Agent': 'Mozilla/5.0 (compatible; QuizAI-Bot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'close',
        },
      };

      let received = 0;
      const req = lib.request(options, (res) => {
        // Follow redirect once
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
          req.destroy();
          this.extractText(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`URL returned HTTP ${res.statusCode}`));
          return;
        }

        let chunks = [];
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > this.maxBytes) { req.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });

      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error('URL fetch timed out after 15s')); });
      req.on('error', (e) => reject(new Error('Could not reach URL: ' + e.message)));
      req.end();
    });
  }

  // ── HTML → Plain Text ────────────────────────────────────
  _htmlToText(html) {
    // Remove script, style, nav, footer, header blocks
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // Convert block/heading tags to newlines
    html = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(h[1-6]|p|div|li|tr|blockquote|article|section|main)[^>]*>/gi, '\n');

    // Strip remaining tags
    html = html.replace(/<[^>]+>/g, ' ');

    // Decode common HTML entities
    html = html
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ');

    // Collapse whitespace
    return html.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
}

module.exports = new UrlService();
