// =============================================================================
// Servidor para jugar a PSOE STRIKES BACK desde el móvil.
// Sirve los archivos de esta carpeta en tu red Wi-Fi. Ábrelo con el archivo
// "JUGAR-EN-MOVIL.bat" y escribe en el navegador del móvil la dirección que
// aparece (el móvil tiene que estar conectado al mismo Wi-Fi que el ordenador).
// =============================================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const FIRST_PORT = 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, path.normalize(urlPath));
  // Solo se sirven archivos de dentro de esta carpeta
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Prohibido');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// Direcciones de este ordenador en la red local (las que puede usar el móvil).
// Se ordenan para que la del Wi-Fi salga la primera y se descartan las de
// adaptadores virtuales (VirtualBox, VMware, WSL...) y las que no sirven.
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/wi-?fi|wlan|wireless|inal[aá]mbric/i.test(name)) score += 3;
      else if (/ethernet|eth|en\d/i.test(name)) score += 1;
      if (/virtual|vmware|vbox|vethernet|hyper-v|wsl|docker|loopback|bluetooth/i.test(name)) score -= 5;
      if (a.address.startsWith('192.168.56.')) score -= 4; // red típica de VirtualBox
      if (a.address.startsWith('192.168.')) score += 1;
      out.push({ ip: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score).map(a => a.ip);
}

function start(port) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && port < FIRST_PORT + 20) start(port + 1); // puerto ocupado: prueba el siguiente
    else { console.error('No se pudo arrancar el servidor:', err.message); process.exit(1); }
  });
  server.listen(port, '0.0.0.0', () => {
    const ips = localAddresses();
    const line = '='.repeat(60);
    console.log('\n' + line);
    console.log('   PSOE STRIKES BACK · servidor para jugar desde el móvil');
    console.log(line + '\n');
    if (ips.length) {
      console.log('   1. Conecta el móvil al MISMO Wi-Fi que este ordenador.');
      console.log('   2. Abre el navegador del móvil (Chrome o Safari) y escribe:\n');
      ips.forEach((ip, i) => console.log(`        ${i === 0 ? '>>' : '  '} http://${ip}:${port}`));
      if (ips.length > 1) console.log('\n      (si la primera no funciona, prueba las otras)');
    } else {
      console.log('   No se encontró ninguna red. ¿Está el ordenador conectado al Wi-Fi?');
    }
    console.log(`\n   En este ordenador también puedes abrir: http://localhost:${port}`);
    console.log('\n   Si Windows pregunta por el Firewall, pulsa "Permitir acceso"');
    console.log('   (en redes privadas).');
    console.log('\n   Deja esta ventana abierta mientras juegas. Ciérrala para apagarlo.');
    console.log(line + '\n');
  });
}

start(FIRST_PORT);
