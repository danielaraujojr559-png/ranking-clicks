// =============================================================================
// server.js — Servidor de Ranking ('Por que Voce Nao Para de Clicar um Pouco')
// =============================================================================
const http = require('http');
const path = require('path');
const fs = require('fs');

// Inicializa SQLite nativo (node:sqlite do Node 24)
let db;
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(__dirname, 'ranking.db');
  db = new DatabaseSync(dbPath);
  console.log(`[SQLite] Conectado em: ${dbPath}`);
} catch (err) {
  console.error('[ERRO] Falha ao carregar SQLite:', err);
  process.exit(1);
}

// Cria tabela e indices
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    nickname TEXT PRIMARY KEY,
    clicks_hoje INTEGER NOT NULL DEFAULT 0,
    clicks_totais INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hoje ON players(clicks_hoje DESC);
  CREATE INDEX IF NOT EXISTS idx_total ON players(clicks_totais DESC);
`);

// Prepared statements
const stmtUpsert = db.prepare(`
  INSERT INTO players (nickname, clicks_hoje, clicks_totais, updated_at)
  VALUES (?, ?, ?, datetime('now', 'localtime'))
  ON CONFLICT(nickname) DO UPDATE SET
    clicks_hoje = excluded.clicks_hoje,
    clicks_totais = excluded.clicks_totais,
    updated_at = excluded.updated_at
`);
const stmtDelete = db.prepare('DELETE FROM players WHERE nickname = ?');
const stmtGetPlayer = db.prepare('SELECT nickname, clicks_hoje, clicks_totais FROM players WHERE nickname = ?');



// Objeto / Mapa em memoria para suportar multiplos jogadores concorrentes
const playersStore = new Map();

// Carrega os jogadores existentes do SQLite para a memoria
try {
  const existingRows = db.prepare('SELECT nickname, clicks_hoje, clicks_totais, updated_at FROM players').all();
  for (const row of existingRows) {
    playersStore.set(row.nickname, {
      nickname: row.nickname,
      clicks_hoje: Number(row.clicks_hoje) || 0,
      clicks_totais: Number(row.clicks_totais) || 0,
      updated_at: row.updated_at
    });
  }
  console.log(`[Multiplayer] ${playersStore.size} jogador(es) ativos na memoria.`);
} catch (err) {
  console.warn('[Multiplayer] Inicializacao da memoria:', err.message);
}

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---------------------------------------------------------------------------
  // POST /sync -> Sincronizacao dos cliques
  // ---------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/sync') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let { nickname, clicks_hoje, clicks_totais } = data;

        if (!nickname || typeof nickname !== 'string') {
          nickname = 'Jogador_Anonimo';
        }
        nickname = nickname.trim().substring(0, 32);
        clicks_hoje = Number(clicks_hoje) || 0;
        clicks_totais = Number(clicks_totais) || 0;

        // 1. Armazena no objeto em memoria
        const nowFormatted = new Date().toLocaleString('pt-BR');
        playersStore.set(nickname, {
          nickname,
          clicks_hoje,
          clicks_totais,
          updated_at: nowFormatted
        });

        // 2. Persiste no banco de dados SQLite
        stmtUpsert.run(nickname, clicks_hoje, clicks_totais);
        console.log(`[SYNC] ${new Date().toLocaleTimeString()} - '${nickname}' | Hoje: ${clicks_hoje} | Total: ${clicks_totais} (Jogadores: ${playersStore.size})`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, nickname, clicks_hoje, clicks_totais }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload invalido' }));
      }
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Servir arquivos estaticos da pasta 'public' (ex: /fundo.gif)
  // ---------------------------------------------------------------------------
  const publicDir = path.join(__dirname, 'public');
  const safePath = path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, '');
  const publicFilePath = path.join(publicDir, safePath);
  if ((req.method === 'GET' || req.method === 'HEAD') && fs.existsSync(publicFilePath) && fs.statSync(publicFilePath).isFile()) {
    const ext = path.extname(publicFilePath).toLowerCase();
    const mimeTypes = {
      '.gif': 'image/gif',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.ico': 'image/x-icon'
    };
    const stat = fs.statSync(publicFilePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': stat.size
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(fs.readFileSync(publicFilePath));
  }

  // ---------------------------------------------------------------------------
  // GET/HEAD /bg-left.gif ou /gkeFN9gA4sx... -> GIF Esquerda (Tung Tung Sahur)
  // ---------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/bg-left.gif' || url.pathname.includes('gkeFN9gA4sx'))) {
    const imgPath = path.join(__dirname, 'bg-left.gif');
    if (fs.existsSync(imgPath)) {
      const stat = fs.statSync(imgPath);
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': stat.size
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(fs.readFileSync(imgPath));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Imagem nao encontrada');
  }

  // ---------------------------------------------------------------------------
  // GET/HEAD /bg-right.gif ou /uooPxAQnt1j... -> GIF Direita (Triple T)
  // ---------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/bg-right.gif' || url.pathname.includes('uooPxAQnt1j'))) {
    const imgPath = path.join(__dirname, 'bg-right.gif');
    if (fs.existsSync(imgPath)) {
      const stat = fs.statSync(imgPath);
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': stat.size
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(fs.readFileSync(imgPath));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Imagem nao encontrada');
  }

  // ---------------------------------------------------------------------------
  // GET/HEAD /background.gif -> Fundo animado legado
  // ---------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/background.gif') {
    const imgPath = path.join(__dirname, 'bg-left.gif');
    if (fs.existsSync(imgPath)) {
      const stat = fs.statSync(imgPath);
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': stat.size
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(fs.readFileSync(imgPath));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Imagem nao encontrada');
  }

  // ---------------------------------------------------------------------------
  // GET /ranking -> Interface Web do Ranking
  // ---------------------------------------------------------------------------
  if (req.method === 'GET' && (url.pathname === '/ranking' || url.pathname === '/')) {
    try {
      const htmlPath = path.join(__dirname, 'ranking.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Erro ao carregar ranking.html');
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // GET /api/ranking -> API REST JSON para o auto-refresh com multiplos jogadores
  // ---------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/ranking') {
    try {
      const allPlayers = Array.from(playersStore.values());

      const topToday = [...allPlayers]
        .sort((a, b) => b.clicks_hoje - a.clicks_hoje)
        .slice(0, 50);

      const topTotal = [...allPlayers]
        .sort((a, b) => b.clicks_totais - a.clicks_totais)
        .slice(0, 50);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ top_today: topToday, top_total: topTotal }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falha ao buscar dados' }));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // GET/DELETE /api/admin/delete/:nickname?senha=1234 -> Deleta jogador do ranking
  // ---------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'DELETE') && url.pathname.startsWith('/api/admin/delete/')) {
    const rawNickname = url.pathname.slice('/api/admin/delete/'.length);
    const nickname = decodeURIComponent(rawNickname).trim();
    const senha = url.searchParams.get('senha');
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

    if (senha !== ADMIN_PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Acesso negado: senha incorreta ou ausente (?senha=1234)' }));
      return;
    }

    if (!nickname) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Nickname não informado na URL' }));
      return;
    }

    try {
      const existedInMem = playersStore.has(nickname);
      playersStore.delete(nickname);
      const dbResult = stmtDelete.run(nickname);

      console.log(`[ADMIN] Jogador '${nickname}' removido por admin. (Memória: ${existedInMem}, SQLite afetados: ${dbResult.changes})`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        message: `Jogador '${nickname}' foi completamente removido do ranking!`,
        removido_memoria: existedInMem,
        removido_sqlite: dbResult.changes > 0,
        jogadores_restantes: playersStore.size
      }));
    } catch (err) {
      console.error('[ADMIN] Erro ao deletar jogador:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Erro interno ao excluir jogador' }));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // GET/POST /api/admin/merge/:oldName/:newName?senha=1234 -> Funde cliques de 2 contas
  // ---------------------------------------------------------------------------
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname.startsWith('/api/admin/merge/')) {
    const pathParts = url.pathname.slice('/api/admin/merge/'.length).split('/').filter(Boolean);
    const oldName = decodeURIComponent(pathParts[0] || '').trim();
    const newName = decodeURIComponent(pathParts[1] || '').trim();
    const senha = url.searchParams.get('senha');
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

    if (senha !== ADMIN_PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Acesso negado: senha incorreta ou ausente (?senha=1234)' }));
      return;
    }

    if (!oldName || !newName) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Parâmetros incompletos. Formato esperado: /api/admin/merge/:oldName/:newName?senha=1234' }));
      return;
    }

    if (oldName.toLowerCase() === newName.toLowerCase()) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'oldName e newName não podem ser o mesmo jogador' }));
      return;
    }

    try {
      const oldPlayerDb = stmtGetPlayer.get(oldName);
      const newPlayerDb = stmtGetPlayer.get(newName);
      const oldPlayerMem = playersStore.get(oldName);
      const newPlayerMem = playersStore.get(newName);

      if (!oldPlayerDb && !oldPlayerMem) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Jogador antigo '${oldName}' não foi encontrado no ranking.` }));
        return;
      }

      const oldHoje = Math.max(
        oldPlayerMem ? Number(oldPlayerMem.clicks_hoje) || 0 : 0,
        oldPlayerDb ? Number(oldPlayerDb.clicks_hoje) || 0 : 0
      );
      const oldTotal = Math.max(
        oldPlayerMem ? Number(oldPlayerMem.clicks_totais) || 0 : 0,
        oldPlayerDb ? Number(oldPlayerDb.clicks_totais) || 0 : 0
      );

      const newHojeExisting = Math.max(
        newPlayerMem ? Number(newPlayerMem.clicks_hoje) || 0 : 0,
        newPlayerDb ? Number(newPlayerDb.clicks_hoje) || 0 : 0
      );
      const newTotalExisting = Math.max(
        newPlayerMem ? Number(newPlayerMem.clicks_totais) || 0 : 0,
        newPlayerDb ? Number(newPlayerDb.clicks_totais) || 0 : 0
      );

      const mergedHoje = newHojeExisting + oldHoje;
      const mergedTotal = newTotalExisting + oldTotal;

      // 1. Transação SQLite: UPSERT com a soma no newName e DELETE no oldName
      db.exec('BEGIN');
      try {
        stmtUpsert.run(newName, mergedHoje, mergedTotal);
        stmtDelete.run(oldName);
        db.exec('COMMIT');
      } catch (txErr) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw txErr;
      }

      // 2. Atualiza memória (playersStore)
      const nowFormatted = new Date().toLocaleString('pt-BR');
      playersStore.set(newName, {
        nickname: newName,
        clicks_hoje: mergedHoje,
        clicks_totais: mergedTotal,
        updated_at: nowFormatted
      });
      playersStore.delete(oldName);

      console.log(`[ADMIN MERGE] '${oldName}' fundido em '${newName}'. Hoje: ${mergedHoje} (+${oldHoje}), Total: ${mergedTotal} (+${oldTotal}).`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        message: `Cliques de '${oldName}' foram fundidos com sucesso em '${newName}'!`,
        merged: {
          nickname: newName,
          clicks_hoje: mergedHoje,
          clicks_totais: mergedTotal,
          adicionados_hoje: oldHoje,
          adicionados_total: oldTotal
        },
        old_player_removido: oldName,
        jogadores_restantes: playersStore.size
      }));
    } catch (err) {
      console.error('[ADMIN MERGE] Erro ao fundir jogadores:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Erro interno ao fundir jogadores' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Rota nao encontrada. Acesse /ranking');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RankingServer] Rodando em http://localhost:${PORT}/ranking`);
});
