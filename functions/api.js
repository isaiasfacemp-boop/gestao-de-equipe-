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

import { neon } from "@neondatabase/serverless";

const PARTE_BYTES = 1024 * 1024;               // 1 MB por linha
const SESSAO_DIAS = 30;

async function hash(s) {
  const data = new TextEncoder().encode(String(s || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hex(buf){ return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256hex(str){ return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))); }
async function sha512hex(str){ return hex(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(str))); }
async function pbkdf2hex(senha, salt, iter, bits){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: iter }, key, bits));
}
// Confere uma senha contra o formato antigo (salt + hash), tentando as combinações mais comuns.
async function conferirAntigo(senha, salt, hashAntigo){
  const alvo = String(hashAntigo || "").toLowerCase();
  const cands = [salt + senha, senha + salt, salt + ":" + senha, senha + ":" + salt];
  for (const c of cands) { if ((await sha256hex(c)) === alvo) return true; if ((await sha512hex(c)) === alvo) return true; }
  for (const it of [1000, 10000, 100000, 210000]) {
    for (const bits of [256, 512]) { try { if ((await pbkdf2hex(senha, salt, it, bits)) === alvo) return true; } catch (e) {} }
  }
  return false;
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
      let ok = !!u && u.senha === h;
      if (u && !ok && u.salt) {
        // usuário importado do sistema antigo: confere no formato antigo e converte para o novo
        ok = await conferirAntigo(String(body.senha || ""), String(u.salt), u.senha);
        if (ok) await db.prepare("UPDATE usuarios SET senha = ?, salt = NULL WHERE usuario = ?").bind(h, u.usuario).run();
      }
      if (!ok) return json(401, { erro: "Usuário ou senha incorretos." });
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


// ---------- Importação única do Neon ----------
// Abra no navegador:  https://SEU-SITE/api?importar=neon          → importa
//                     https://SEU-SITE/api?importar=neon&ver=1    → só mostra as tabelas/colunas do Neon
// Só importa enquanto o D1 ainda está vazio (sem estado salvo) e usa a variável DATABASE_URL.
function pegar(obj, nomes) {
  for (const n of nomes) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  return undefined;
}
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const txt = (status, t) => new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (url.searchParams.get("importar") !== "neon") return txt(404, "Nada aqui.");
  const db = env.DB;
  if (!db) return txt(500, "Banco D1 não configurado (binding DB).");
  if (!env.DATABASE_URL) return txt(500, "Variável DATABASE_URL (do Neon) não está configurada no projeto.");

  try {
    const sql = neon(env.DATABASE_URL);
    const colunas = await sql`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
    const esquema = {};
    for (const c of colunas) (esquema[c.table_name] = esquema[c.table_name] || []).push(c.column_name + " (" + c.data_type + ")");
    const descricao = Object.keys(esquema).map(t => t + ": " + esquema[t].join(", ")).join("\n");

    if (url.searchParams.get("ver")) return txt(200, "Tabelas no Neon:\n" + descricao);

    const ja = await db.prepare("SELECT versao FROM dados WHERE id = 1").first();
    if (ja) return txt(409, "O D1 já tem dados salvos — importação recusada para não sobrescrever.");

    const tabUsu = url.searchParams.get("usuarios") || "usuarios";
    const tabDad = url.searchParams.get("dados") || "dados";
    if (!esquema[tabUsu] || !esquema[tabDad]) return txt(400, "Não achei as tabelas '" + tabUsu + "' e/ou '" + tabDad + "'.\n\nTabelas no Neon:\n" + descricao);

    const usuarios = await sql("SELECT * FROM " + tabUsu.replace(/[^a-z0-9_]/gi, ""));
    const dadosRows = await sql("SELECT * FROM " + tabDad.replace(/[^a-z0-9_]/gi, "") + " LIMIT 1");

    const stmts = [db.prepare("DELETE FROM usuarios")];
    let importados = 0, semHash = [];
    for (const u of usuarios) {
      const nome = pegar(u, ["usuario", "username", "user", "login", "nome"]);
      const senha = pegar(u, ["senha", "senha_hash", "pass_hash", "passhash", "password", "hash"]);
      const salt = pegar(u, ["salt", "sal"]);
      if (!nome || !senha) continue;
      const master = pegar(u, ["master"]);
      const role = pegar(u, ["role", "papel", "perfil"]);
      const ehMaster = master === true || master === 1 || master === "true" || role === "master";
      const trocar = pegar(u, ["trocar", "must_change", "mustchange", "trocar_senha"]);
      const deveTrocar = trocar === undefined ? 0 : (trocar === true || trocar === 1 || trocar === "true" ? 1 : 0);
      if (salt) semHash.push(String(nome));
      stmts.push(db.prepare("INSERT INTO usuarios (usuario, senha, master, trocar, salt) VALUES (?, ?, ?, ?, ?)")
        .bind(String(nome), String(senha), ehMaster ? 1 : 0, deveTrocar, salt ? String(salt) : null));
      importados++;
    }
    if (importados === 0) {
      const h = await hash("admin");
      stmts.push(db.prepare("INSERT INTO usuarios (usuario, senha, master, trocar) VALUES ('admin', ?, 1, 1)").bind(h));
    }
    await db.batch(stmts);

    let tarefas = 0, anexos = 0, antes = 0, depois = 0;
    const linha = dadosRows[0];
    let conteudo = linha ? pegar(linha, ["conteudo", "estado", "state", "data", "json", "dados"]) : null;
    if (!conteudo && esquema["sistema"]) {
      // versões antigas guardavam o estado na tabela "sistema" (chave/conteudo)
      const sis = await sql("SELECT chave, conteudo FROM sistema");
      const cand = sis.find(r => r.conteudo && typeof r.conteudo === "object" && Array.isArray(r.conteudo.tasks)) || sis.find(r => r.conteudo && typeof r.conteudo === "string" && r.conteudo.includes("\"tasks\""));
      if (cand) conteudo = cand.conteudo;
    }
    if (conteudo) {
      if (typeof conteudo === "string") conteudo = JSON.parse(conteudo);
      antes = JSON.stringify(conteudo).length;
      await migrarAnexosEmbutidos(db, conteudo);
      tarefas = Array.isArray(conteudo.tasks) ? conteudo.tasks.length : 0;
      anexos = (conteudo.tasks || []).filter(t => t.protocoladoPdf && t.protocoladoPdf.id).length;
      const texto = JSON.stringify(conteudo);
      depois = texto.length;
      if (texto.length > 1900000) return txt(413, "Estado grande demais mesmo sem os PDFs (" + texto.length + " bytes).");
      await db.prepare("INSERT INTO dados (id, conteudo, versao, atualizado_em) VALUES (1, ?, 1, ?)").bind(texto, Date.now()).run();
    }
    return txt(200,
      "Importado.\n" +
      "Usuários: " + importados + (semHash.length ? " (com senha no formato antigo, convertida automaticamente no primeiro login: " + semHash.join(", ") + ")" : "") + "\n" +
      "Estado: " + (conteudo ? "sim — " + tarefas + " tarefas, " + anexos + " PDFs movidos para anexos, " + antes + " → " + depois + " bytes" : "o Neon não tinha estado salvo") + "\n\n" +
      "Tabelas encontradas no Neon:\n" + descricao + "\n\nPode fechar esta aba e entrar no app.");
  } catch (e) {
    return txt(500, "Erro ao importar: " + (e && e.message ? e.message : String(e)));
  }
}
