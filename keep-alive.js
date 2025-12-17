// Keep-alive сервер для Replit (предотвращает "засыпание" бесплатного плана)
import http from 'http';

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive!');
});

// Обработка ошибок
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use, keep-alive server skipped`);
  } else {
    console.error('Keep-alive server error:', err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});


