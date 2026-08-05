// Funcao /api - backend real do app "Gestao de Equipe", usando Neon (Postgres).
// Formato: Cloudflare Pages Functions.
// Espelha exatamente as mesmas acoes que o modo local (localApi) ja usava no app.

import { neon } from "@neondatabase/serverless";

async function hash(s) {
  const data = new TextEncoder().encode(String(s || ""));
    const digest = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      function uid() {
        return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");
        }

        async function ensureSchema(sql) {
        await sql`CREATE TABLE IF NOT EXISTS usuarios (
        usuario   text PRIMARY KEY,
        senha     text NOT NULL,
        master    boolean NOT NULL DEFAULT false,
        trocar    boolean NOT NULL DEFAULT true
        )`;
        await sql`CREATE TABLE IF NOT EXISTS sessoes (
        token     text PRIMARY KEY,
        usuario   text NOT NULL,
        criado_em timestamptz NOT NULL DEFAULT now()
        )`;
        await sql`CREATE TABLE IF NOT EXISTS dados (
        id        int PRIMARY KEY DEFAULT 1,
        conteudo  jsonb
        )`;
        const existentes = await sql`SELECT usuario FROM usuarios LIMIT 1`;
        if (existentes.length === 0) {
        const h = await hash("admin");
        await sql`INSERT INTO usuarios (usuario, senha, master, trocar) VALUES ('admin', ${h}, true, true)`;
        }
        }

        async function achar(sql, usuario) {
        const rows = await sql`SELECT * FROM usuarios WHERE lower(usuario) = lower(${usuario}) LIMIT 1`;
        return rows[0] || null;
        }
        async function usuarioDoToken(sql, token) {
        if (!token) return null;
        const rows = await sql`SELECT usuario FROM sessoes WHERE token = ${token} LIMIT 1`;
        if (!rows[0]) return null;
        return achar(sql, rows[0].usuario);
        }

        export async function onRequestPost(context) {
        const { request, env } = context;
        const sql = neon(env.DATABASE_URL);

        const json = (statusCode, obj) => new Response(JSON.stringify(obj), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
        });

        let body;
        try { body = await request.json(); }
        catch (e) { return json(400, { erro: "JSON invalido." }); }

        const { acao, token } = body;

        try {
        await ensureSchema(sql);

        if (acao === "login") {
        const u = await achar(sql, body.user);
        const h = await hash(body.senha);
        if (!u || u.senha !== h) {
        return json(401, { erro: "Usuario ou senha incorretos." });
        }
        const novoToken = uid();
        await sql`INSERT INTO sessoes (token, usuario) VALUES (${novoToken}, ${u.usuario})`;
        return json(200, { token: novoToken, user: u.usuario, master: !!u.master, trocar: !!u.trocar });
        }

        const eu = await usuarioDoToken(sql, token);
        if (!eu) return json(401, { erro: "Sessao expirada. Entre novamente." });

        if (acao === "perfil") {
        return json(200, { user: eu.usuario, master: !!eu.master, trocar: !!eu.trocar });
        }

        if (acao === "carregar") {
        const rows = await sql`SELECT conteudo FROM dados WHERE id = 1 LIMIT 1`;
        return json(200, { conteudo: rows[0] ? rows[0].conteudo : null });
        }

        if (acao === "salvar") {
        await sql`INSERT INTO dados (id, conteudo) VALUES (1, ${JSON.stringify(body.conteudo || {})}::jsonb) ON CONFLICT (id) DO UPDATE SET conteudo = EXCLUDED.conteudo`;
        return json(200, { ok: true });
        }

        if (acao === "trocarSenha") {
        const h = await hash(body.nova);
        await sql`UPDATE usuarios SET senha = ${h}, trocar = false WHERE usuario = ${eu.usuario}`;
        return json(200, { ok: true });
        }

        if (acao === "listarUsuarios") {
        if (!eu.master) return json(403, { erro: "Apenas o master." });
        const rows = await sql`SELECT usuario, master FROM usuarios ORDER BY usuario`;
        return json(200, { usuarios: rows.map(r => ({ usuario: r.usuario, master: !!r.master })), voce: eu.usuario });
        }

        if (acao === "cadastrarUsuario") {
        if (!eu.master) return json(403, { erro: "Apenas o master." });
        const jaExiste = await achar(sql, body.user);
        if (jaExiste) return json(409, { erro: "Ja existe um usuario com esse login." });
        const h = await hash(body.senha);
        await sql`INSERT INTO usuarios (usuario, senha, master, trocar) VALUES (${String(body.user).trim()}, ${h}, ${body.master === true}, true)`;
        return json(200, { ok: true });
        }

        if (acao === "redefinirSenha") {
        if (!eu.master) return json(403, { erro: "Apenas o master." });
        const alvo = await achar(sql, body.user);
        if (!alvo) return json(404, { erro: "Usuario nao encontrado." });
        const h = await hash(body.senha);
        await sql`UPDATE usuarios SET senha = ${h}, trocar = true WHERE usuario = ${alvo.usuario}`;
        return json(200, { ok: true });
        }

        if (acao === "excluirUsuario") {
        if (!eu.master) return json(403, { erro: "Apenas o master." });
        const alvoLower = String(body.user || "").toLowerCase();
        if (alvoLower === eu.usuario.toLowerCase()) return json(400, { erro: "Voce nao pode excluir o usuario conectado." });
        const total = await sql`SELECT count(*)::int AS n FROM usuarios`;
        if (total[0].n <= 1) return json(400, { erro: "E preciso manter pelo menos um usuario." });
        await sql`DELETE FROM usuarios WHERE lower(usuario) = ${alvoLower}`;
        return json(200, { ok: true });
        }

        return json(400, { erro: "Acao desconhecida." });
        } catch (e) {
        return json(500, { erro: "Erro no servidor: " + (e && e.message ? e.message : String(e)) });
        }
        }
        
