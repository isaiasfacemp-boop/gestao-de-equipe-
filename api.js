// Função /api — backend do app "Equipe · Gestão de Trabalho".
// Formato: Cloudflare Pages Functions. Banco: Cloudflare D1 (binding "DB").
//
// Mesmas ações da versão anterior (Neon), mais:
//   - "carregar" aceita { versao } e responde { semMudanca:true } se nada mudou
//     (evita baixar o estado inteiro a cada sincronização);
//   - "salvar" devolve a nova { versao };
//   - "enviarAnexo" / "baixarAnexo" / "excluirAnexo": PDFs ficam fora do estado,
//     em pedaços de 1 MB (o D1 aceita no máximo 2 MB por linha).
// Ao salvar, qualquer task.protocoladoPdf que ainda venha com "data" embutido
// (formato antigo) é movido automaticamente para a tabela de anexos.

const PARTE_BYTES = 1024 * 1024;               // 1 MB por linha
const SESSAO_DIAS = 30;

async function hash(s) {
  const data = new TextEncoder().encode(String(s || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function uid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function ensureAdmin(db) {
  const r = await db.prepare("SELECT usuario FROM usuarios LIMIT 1").first();
  if (!r) {
    const h = await hash("admin");
    await db.prepare("INSERT INTO usuarios (usuario, senha, master, trocar) VALUES ('admin', ?, 1, 1)").bind(h).run();
  }
}
async function achar(db, usuario) {
  return db.prepare("SELECT * FROM usuarios WHERE lower(usuario) = lower(?) LIMIT 1").bind(String(usuario || "")).first();
}
async function usuarioDoToken(db, token) {
  if (!token) return null;
  const s = await db.prepare("SELECT usuario, criado_em FROM sessoes WHERE token = ? LIMIT 1").bind(token).first();
  if (!s) return null;
  if (Date.now() - s.criado_em > SESSAO_DIAS * 86400000) {
    await db.prepare("DELETE FROM sessoes WHERE token = ?").bind(token).run();
    return null;
  }
  return achar(db, s.usuario);
}

// ---------- anexos ----------
async function guardarAnexo(db, nome, dataUrl, tamanho) {
  const id = uid();
  const partes = [];
  for (let i = 0; i < dataUrl.length; i += PARTE_BYTES) partes.push(dataUrl.slice(i, i + PARTE_BYTES));
  const stmts = [
    db.prepare("INSERT INTO anexos_meta (id, nome, tamanho, partes, criado_em) VALUES (?, ?, ?, ?, ?)")
      .bind(id, String(nome || "anexo.pdf"), Number(tamanho) || dataUrl.length, partes.length, Date.now()),
  ];
  partes.forEach((p, i) => stmts.push(db.prepare("INSERT INTO anexos (id, parte, dados) VALUES (?, ?, ?)").bind(id, i, p)));
  await db.batch(stmts);
  return id;
}
async function lerAnexo(db, id) {
  const meta = await db.prepare("SELECT * FROM anexos_meta WHERE id = ?").bind(id).first();
  if (!meta) return null;
  const { results } = await db.prepare("SELECT dados FROM anexos WHERE id = ? ORDER BY parte").bind(id).all();
  return { id, name: meta.nome, size: meta.tamanho, uploadedAt: meta.criado_em, data: results.map(r => r.dados).join("") };
}
async function apagarAnexo(db, id) {
  await db.batch([
    db.prepare("DELETE FROM anexos WHERE id = ?").bind(id),
    db.prepare("DELETE FROM anexos_meta WHERE id = ?").bind(id),
  ]);
}
// Move PDFs embutidos no estado (formato antigo) para a tabela de anexos.
async function migrarAnexosEmbutidos(db, conteudo) {
  if (!conteudo || !Array.isArray(conteudo.tasks)) return conteudo;
  for (const t of conteudo.tasks) {
    const p = t && t.protocoladoPdf;
    if (p && typeof p.data === "string" && p.data.length > 0) {
      const id = await guardarAnexo(db, p.name, p.data, p.size);
      t.protocoladoPdf = { id, name: p.name, size: p.size, uploadedAt: p.uploadedAt || Date.now() };
    }
  }
  return conteudo;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  const json = (status, obj) => new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (!db) return json(500, { erro: "Banco D1 não configurado (binding DB)." });

  let body;
  try { body = await request.json(); }
  catch (e) { return json(400, { erro: "JSON inválido." }); }

  const { acao, token } = body;

  try {
    await ensureAdmin(db);

    if (acao === "login") {
      const u = await achar(db, body.user);
      const h = await hash(body.senha);
      if (!u || u.senha !== h) return json(401, { erro: "Usuário ou senha incorretos." });
      const novoToken = uid();
      await db.prepare("INSERT INTO sessoes (token, usuario, criado_em) VALUES (?, ?, ?)").bind(novoToken, u.usuario, Date.now()).run();
      return json(200, { token: novoToken, user: u.usuario, master: !!u.master, trocar: !!u.trocar });
    }

    const eu = await usuarioDoToken(db, token);
    if (!eu) return json(401, { erro: "Sessão expirada. Entre novamente." });

    if (acao === "perfil") {
      return json(200, { user: eu.usuario, master: !!eu.master, trocar: !!eu.trocar });
    }

    if (acao === "carregar") {
      const versaoCliente = Number(body.versao) || 0;
      if (versaoCliente > 0) {
        const v = await db.prepare("SELECT versao FROM dados WHERE id = 1").first();
        if (v && v.versao === versaoCliente) return json(200, { semMudanca: true, versao: v.versao });
      }
      const row = await db.prepare("SELECT conteudo, versao FROM dados WHERE id = 1").first();
      if (!row) return json(200, { conteudo: null, versao: 0 });
      return json(200, { conteudo: JSON.parse(row.conteudo), versao: row.versao });
    }

    if (acao === "salvar") {
      const conteudo = await migrarAnexosEmbutidos(db, body.conteudo || {});
      const texto = JSON.stringify(conteudo);
      if (texto.length > 1900000) return json(413, { erro: "Estado grande demais para salvar (limite 1,9 MB)." });
      const r = await db.prepare(
        "INSERT INTO dados (id, conteudo, versao, atualizado_em) VALUES (1, ?, 1, ?) " +
        "ON CONFLICT (id) DO UPDATE SET conteudo = excluded.conteudo, versao = dados.versao + 1, atualizado_em = excluded.atualizado_em " +
        "RETURNING versao"
      ).bind(texto, Date.now()).first();
      return json(200, { ok: true, versao: r ? r.versao : 1 });
    }

    if (acao === "enviarAnexo") {
      const data = String(body.data || "");
      if (!data.startsWith("data:application/pdf")) return json(400, { erro: "Apenas PDF." });
      if (data.length > 12 * 1024 * 1024) return json(413, { erro: "O PDF precisa ter até 8MB." });
      const id = await guardarAnexo(db, body.nome, data, body.tamanho);
      return json(200, { id, name: String(body.nome || "anexo.pdf"), size: Number(body.tamanho) || 0, uploadedAt: Date.now() });
    }
    if (acao === "baixarAnexo") {
      const a = await lerAnexo(db, String(body.id || ""));
      if (!a) return json(404, { erro: "Anexo não encontrado." });
      return json(200, a);
    }
    if (acao === "excluirAnexo") {
      await apagarAnexo(db, String(body.id || ""));
      return json(200, { ok: true });
    }

    if (acao === "trocarSenha") {
      const h = await hash(body.nova);
      await db.prepare("UPDATE usuarios SET senha = ?, trocar = 0 WHERE usuario = ?").bind(h, eu.usuario).run();
      return json(200, { ok: true });
    }

    if (acao === "listarUsuarios") {
      if (!eu.master) return json(403, { erro: "Apenas o master." });
      const { results } = await db.prepare("SELECT usuario, master FROM usuarios ORDER BY usuario").all();
      return json(200, { usuarios: results.map(r => ({ usuario: r.usuario, master: !!r.master })), voce: eu.usuario });
    }

    if (acao === "cadastrarUsuario") {
      if (!eu.master) return json(403, { erro: "Apenas o master." });
      const jaExiste = await achar(db, body.user);
      if (jaExiste) return json(409, { erro: "Já existe um usuário com esse login." });
      const h = await hash(body.senha);
      await db.prepare("INSERT INTO usuarios (usuario, senha, master, trocar) VALUES (?, ?, ?, 1)")
        .bind(String(body.user).trim(), h, body.master === true ? 1 : 0).run();
      return json(200, { ok: true });
    }

    if (acao === "redefinirSenha") {
      if (!eu.master) return json(403, { erro: "Apenas o master." });
      const alvo = await achar(db, body.user);
      if (!alvo) return json(404, { erro: "Usuário não encontrado." });
      const h = await hash(body.senha);
      await db.prepare("UPDATE usuarios SET senha = ?, trocar = 1 WHERE usuario = ?").bind(h, alvo.usuario).run();
      return json(200, { ok: true });
    }

    if (acao === "excluirUsuario") {
      if (!eu.master) return json(403, { erro: "Apenas o master." });
      const alvoLower = String(body.user || "").toLowerCase();
      if (alvoLower === eu.usuario.toLowerCase()) return json(400, { erro: "Você não pode excluir o usuário conectado." });
      const total = await db.prepare("SELECT count(*) AS n FROM usuarios").first();
      if (total.n <= 1) return json(400, { erro: "É preciso manter pelo menos um usuário." });
      await db.batch([
        db.prepare("DELETE FROM usuarios WHERE lower(usuario) = ?").bind(alvoLower),
        db.prepare("DELETE FROM sessoes WHERE lower(usuario) = ?").bind(alvoLower),
      ]);
      return json(200, { ok: true });
    }

    return json(400, { erro: "Ação desconhecida." });
  } catch (e) {
    return json(500, { erro: "Erro no servidor: " + (e && e.message ? e.message : String(e)) });
  }
}
