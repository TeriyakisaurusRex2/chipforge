/* Tiny static server for ChipForge — zero dependencies.
   You normally don't need this (just double-click index.html);
   it exists for anything that prefers http://localhost, e.g. if
   a browser ever refuses Web MIDI on file:// pages.
   Run:  node serve.js   then open http://localhost:8474 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(__dirname, url === '/' ? 'index.html' : url);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8474, () => console.log('ChipForge running at http://localhost:8474'));
