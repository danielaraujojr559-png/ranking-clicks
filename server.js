// =============================================================================
// server.js — Ranking Backend (Vercel Serverless + Turso/libSQL)
// =============================================================================
// Deploy: Vercel (serverless functions)
// Database: Turso (libSQL) — persistência permanente e gratuita
// Env vars necessárias no painel da Vercel:
//   TURSO_DATABASE_URL  — ex: libsql://seu-db-usuario.turso.io
//   TURSO_AUTH_TOKEN    — token gerado no Turso CLI
//   ADMIN_PASSWORD      — senha para rotas de admin (default: "1234")
// =============================================================================
const http = require('http');
const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Guardas de processo globais
// ---------------------------------------------------------------------------
process.on('uncaughtException',   (err)    => console.error('[FATAL] uncaughtException:', err));
process.on('unhandledRejection',  (reason) => console.error('[FATAL] unhandledRejection:', reason));

// ---------------------------------------------------------------------------
// Cliente Turso/libSQL — conexão única reutilizada entre invocações
// ---------------------------------------------------------------------------
const { createClient } = require('@libsql/client');

let db;
try {
  let dbUrl   = (process.env.TURSO_DATABASE_URL || '').trim().replace(/[^\x20-\x7E]/g, '');
  let dbToken = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/[^\x20-\x7E]/g, '');

  if (!dbUrl) {
    throw new Error('TURSO_DATABASE_URL não definida. Adicione no painel da Vercel / .env local.');
  }

  db = createClient({
    url:       dbUrl,
    authToken: dbToken || undefined,
  });
  console.log('[Turso] Cliente libSQL criado com sucesso.');
} catch (err) {
  console.error('[ERRO CRITICO] Falha ao criar cliente libSQL:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inicialização da tabela (executada uma vez na cold start)
// ---------------------------------------------------------------------------
async function initDatabase() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS players (
      nickname     TEXT PRIMARY KEY,
      clicks_hoje  INTEGER NOT NULL DEFAULT 0,
      clicks_totais INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hoje  ON players(clicks_hoje  DESC);
    CREATE INDEX IF NOT EXISTS idx_total ON players(clicks_totais DESC);
  `);
  console.log('[Turso] Tabela "players" OK.');
}

// Promise de inicialização — aguardada antes de servir qualquer pedido
const dbReady = initDatabase().catch((err) => {
  console.error('[Turso] Falha na inicialização da tabela:', err);
});

// ---------------------------------------------------------------------------
// Handler principal (async) — exportado para a Vercel e usado localmente
// ---------------------------------------------------------------------------
async function handler(req, res) {
  // Aguarda DB estar pronto (na Vercel isso já terá sido resolvido antes)
  await dbReady;

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const base = `http://${req.headers.host || 'localhost'}`;
  const url  = new URL(req.url, base);
  
  // Extrai o caminho real (suporta query path=$1 do vercel.json, headers ou URL nativa)
  let rawPath = url.searchParams.get('path');
  let pathname = url.pathname;
  if (rawPath !== null && rawPath !== undefined) {
    pathname = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
  } else if (req.headers['x-matched-path']) {
    pathname = req.headers['x-matched-path'];
  } else if (req.headers['x-forwarded-url']) {
    pathname = new URL(req.headers['x-forwarded-url'], base).pathname;
  }
  url.pathname = pathname;
  console.log(`[REQ] ${req.method} raw: ${req.url} -> resolved pathname: ${pathname}`);

  // -------------------------------------------------------------------------
  // POST /sync → Sincronização dos cliques
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/sync') {
    let body = '';
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) { req.destroy(); reject(new Error('Payload too large')); }
      });
      req.on('end',   resolve);
      req.on('error', reject);
    }).catch(() => {});

    try {
      const data = JSON.parse(body);
      let { nickname, clicks_hoje, clicks_totais } = data;

      if (!nickname || typeof nickname !== 'string') nickname = 'Jogador_Anonimo';
      nickname      = nickname.trim().replace(/['"\\]/g, '').substring(0, 32);
      clicks_hoje   = Number(clicks_hoje)   || 0;
      clicks_totais = Number(clicks_totais) || 0;

      const updatedAt = new Date().toLocaleString('pt-BR');

      await db.execute({
        sql: `
          INSERT INTO players (nickname, clicks_hoje, clicks_totais, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(nickname) DO UPDATE SET
            clicks_hoje   = excluded.clicks_hoje,
            clicks_totais = excluded.clicks_totais,
            updated_at    = excluded.updated_at
        `,
        args: [nickname, clicks_hoje, clicks_totais, updatedAt],
      });

      console.log(`[SYNC] '${nickname}' | Hoje: ${clicks_hoje} | Total: ${clicks_totais}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, nickname, clicks_hoje, clicks_totais }));
    } catch (err) {
      console.error('[SYNC] Erro:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload invalido ou erro de DB' }));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Servir ficheiros estáticos da pasta 'public' (GIFs, etc.)
  // -------------------------------------------------------------------------
  const publicDir      = path.join(__dirname, 'public');
  const safePath       = path.normalize(url.pathname).replace(/^(\.\.[\\/])+/, '');
  const publicFilePath = path.join(publicDir, safePath);

  if ((req.method === 'GET' || req.method === 'HEAD') &&
      fs.existsSync(publicFilePath) && fs.statSync(publicFilePath).isFile()) {
    const mimeTypes = {
      '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'application/javascript',
      '.ico': 'image/x-icon'
    };
    const ext  = path.extname(publicFilePath).toLowerCase();
    const stat = fs.statSync(publicFilePath);
    res.writeHead(200, {
      'Content-Type':   mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': stat.size
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(fs.readFileSync(publicFilePath));
  }

  // -------------------------------------------------------------------------
  // GET /bg-left.gif, /bg-right.gif, /background.gif
  // -------------------------------------------------------------------------
  const gifRoutes = {
    '/bg-left.gif':    'bg-left.gif',
    '/bg-right.gif':   'bg-right.gif',
    '/background.gif': 'bg-left.gif',
  };
  for (const [route, file] of Object.entries(gifRoutes)) {
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === route) {
      const imgPath = path.join(__dirname, file);
      if (fs.existsSync(imgPath)) {
        const stat = fs.statSync(imgPath);
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': stat.size });
        if (req.method === 'HEAD') return res.end();
        return res.end(fs.readFileSync(imgPath));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Imagem nao encontrada');
    }
  }

  // -------------------------------------------------------------------------
  // GET / ou /ranking → Interface Web HTML
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && (url.pathname === '/ranking' || url.pathname === '/')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'ranking.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Erro ao carregar ranking.html');
    }
    return;
  }

  // -------------------------------------------------------------------------
  // GET /api/ranking → API JSON com ranking ordenado
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/ranking') {
    try {
      const [todayResult, totalResult] = await Promise.all([
        db.execute({
          sql:  'SELECT nickname, clicks_hoje, clicks_totais, updated_at FROM players ORDER BY clicks_hoje  DESC LIMIT 50',
          args: [],
        }),
        db.execute({
          sql:  'SELECT nickname, clicks_hoje, clicks_totais, updated_at FROM players ORDER BY clicks_totais DESC LIMIT 50',
          args: [],
        }),
      ]);

      const mapRow = (r) => ({
        nickname:      String(r.nickname),
        clicks_hoje:   Number(r.clicks_hoje),
        clicks_totais: Number(r.clicks_totais),
        updated_at:    String(r.updated_at),
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        top_today: todayResult.rows.map(mapRow),
        top_total: totalResult.rows.map(mapRow),
      }));
    } catch (err) {
      console.error('[API/RANKING] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falha ao buscar dados' }));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // GET/DELETE /api/admin/delete/:nickname?senha=... → Remove jogador
  // -------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'DELETE') &&
      url.pathname.startsWith('/api/admin/delete/')) {

    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
    if (url.searchParams.get('senha') !== ADMIN_PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Acesso negado: senha incorreta ou ausente (?senha=...)' }));
      return;
    }

    const nickname = decodeURIComponent(url.pathname.slice('/api/admin/delete/'.length)).trim();
    if (!nickname) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Nickname nao informado' }));
      return;
    }

    try {
      const result = await db.execute({
        sql:  'DELETE FROM players WHERE nickname = ?',
        args: [nickname],
      });

      console.log(`[ADMIN DELETE] '${nickname}' removido. Linhas afetadas: ${result.rowsAffected}`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success:         true,
        message:         `Jogador '${nickname}' removido!`,
        removido_sqlite: result.rowsAffected > 0,
      }));
    } catch (err) {
      console.error('[ADMIN DELETE] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Erro interno ao excluir jogador' }));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // GET/POST /api/admin/merge/:oldName/:newName?senha=... → Funde 2 contas
  // -------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'POST') &&
      url.pathname.startsWith('/api/admin/merge/')) {

    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
    if (url.searchParams.get('senha') !== ADMIN_PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Acesso negado: senha incorreta ou ausente (?senha=...)' }));
      return;
    }

    const parts   = url.pathname.slice('/api/admin/merge/'.length).split('/').filter(Boolean);
    const oldName = decodeURIComponent(parts[0] || '').trim();
    const newName = decodeURIComponent(parts[1] || '').trim();

    if (!oldName || !newName) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Formato: /api/admin/merge/:oldName/:newName?senha=...' }));
      return;
    }
    if (oldName.toLowerCase() === newName.toLowerCase()) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'oldName e newName nao podem ser iguais' }));
      return;
    }

    try {
      const [oldRes, newRes] = await Promise.all([
        db.execute({ sql: 'SELECT clicks_hoje, clicks_totais FROM players WHERE nickname = ?', args: [oldName] }),
        db.execute({ sql: 'SELECT clicks_hoje, clicks_totais FROM players WHERE nickname = ?', args: [newName] }),
      ]);

      const oldRow = oldRes.rows[0];
      if (!oldRow) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Jogador '${oldName}' nao encontrado` }));
        return;
      }
      const newRow = newRes.rows[0];

      const mergedHoje  = Number(oldRow.clicks_hoje)   + (newRow ? Number(newRow.clicks_hoje)   : 0);
      const mergedTotal = Number(oldRow.clicks_totais)  + (newRow ? Number(newRow.clicks_totais) : 0);
      const updatedAt   = new Date().toLocaleString('pt-BR');

      // Transação atómica: UPSERT no novo nick + DELETE no antigo
      await db.batch([
        {
          sql:  `
            INSERT INTO players (nickname, clicks_hoje, clicks_totais, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(nickname) DO UPDATE SET
              clicks_hoje   = excluded.clicks_hoje,
              clicks_totais = excluded.clicks_totais,
              updated_at    = excluded.updated_at
          `,
          args: [newName, mergedHoje, mergedTotal, updatedAt],
        },
        { sql: 'DELETE FROM players WHERE nickname = ?', args: [oldName] },
      ], 'write');

      console.log(`[ADMIN MERGE] '${oldName}' → '${newName}'. Total: ${mergedTotal}`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        message: `Cliques de '${oldName}' fundidos em '${newName}'!`,
        merged:  { nickname: newName, clicks_hoje: mergedHoje, clicks_totais: mergedTotal },
        old_player_removido: oldName,
      }));
    } catch (err) {
      console.error('[ADMIN MERGE] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Erro interno ao fundir jogadores' }));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 404 fallback
  // -------------------------------------------------------------------------
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Rota nao encontrada. Acesse /ranking');
}

// ---------------------------------------------------------------------------
// Exporta para Vercel (serverless function)
// ---------------------------------------------------------------------------
module.exports = handler;

// ---------------------------------------------------------------------------
// Servidor HTTP local (ignorado pela Vercel, usado em desenvolvimento)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[Handler Error]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
  });

  server.on('error', (err) => {
    console.error('[Server Error]', err.message);
    if (err.code === 'EADDRINUSE') console.error(`Porta ${PORT} em uso.`);
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[RankingServer] ONLINE — porta ${PORT}`);
    console.log(`[RankingServer] Node.js ${process.version} | PID ${process.pid}`);
  });
}
