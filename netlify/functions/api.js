// Funcao /api - backend real do app "Gestao de Equipe", usando Neon (Postgres).
// Espelha exatamente as mesmas acoes que o modo local (localApi) ja usava no app,
// entao o front-end nao precisa de nenhuma mudanca: ele detecta sozinho que existe
// servidor e passa a usar dados compartilhados.

const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.DATABASE_URL);

function hash(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
  }
  function uid() {
    return crypto.randomBytes(16).toString("hex");
    }

    async function ensureSchema() {
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
                                                            await sql`INSERT INTO usuarios (usuario, senha, master, trocar)
                                                                          VALUES ('admin', ${hash("admin")}, true, true)`;
                                                                            }
                                                                            }

                                                                            async function achar(usuario) {
                                                                              const rows = await sql`SELECT * FROM usuarios WHERE lower(usuario) = lower(${usuario}) LIMIT 1`;
                                                                                return rows[0] || null;
                                                                                }
                                                                                async function usuarioDoToken(token) {
                                                                                  if (!token) return null;
                                                                                    const rows = await sql`SELECT usuario FROM sessoes WHERE token = ${token} LIMIT 1`;
                                                                                      if (!rows[0]) return null;
                                                                                        return achar(rows[0].usuario);
                                                                                        }


                                                                                        exports.handler = async (event) => {
                                                                                        if (event.httpMethod !== "POST") {
                                                                                        return { statusCode: 405, body: JSON.stringify({ erro: "Metodo nao permitido." }) };
                                                                                        }
                                                                                        let body;
                                                                                        try { body = JSON.parse(event.body || "{}"); }
                                                                                        catch (e) { return { statusCode: 400, body: JSON.stringify({ erro: "JSON invalido." }) }; }

                                                                                        const { acao, token } = body;
                                                                                        const json = (statusCode, obj) => ({
                                                                                        statusCode,
                                                                                        headers: { "Content-Type": "application/json" },
                                                                                        body: JSON.stringify(obj),
                                                                                        });

                                                                                        try {
                                                                                        await ensureSchema();

                                                                                        if (acao === "login") {
                                                                                        const u = await achar(body.user);
                                                                                        if (!u || u.senha !== hash(body.senha)) {
                                                                                        return json(401, { erro: "Usuario ou senha incorretos." });
                                                                                        }
                                                                                        const novoToken = uid();
                                                                                        await sql`INSERT INTO sessoes (token, usuario) VALUES (${novoToken}, ${u.usuario})`;
                                                                                        return json(200, { token: novoToken, user: u.usuario, master: !!u.master, trocar: !!u.trocar });
                                                                                        }

                                                                                        const eu = await usuarioDoToken(token);
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
                                                                                        await sql`UPDATE usuarios SET senha = ${hash(body.nova)}, trocar = false WHERE usuario = ${eu.usuario}`;
                                                                                        return json(200, { ok: true });
                                                                                        }

                                                                                        if (acao === "listarUsuarios") {
                                                                                        if (!eu.master) return json(403, { erro: "Apenas o master." });
                                                                                        const rows = await sql`SELECT usuario, master FROM usuarios ORDER BY usuario`;
                                                                                        return json(200, { usuarios: rows.map(r => ({ usuario: r.usuario, master: !!r.master })), voce: eu.usuario });
                                                                                        }

                                                                                        if (acao === "cadastrarUsuario") {
                                                                                        if (!eu.master) return json(403, { erro: "Apenas o master." });
                                                                                        const jaExiste = await achar(body.user);
                                                                                        if (jaExiste) return json(409, { erro: "Ja existe um usuario com esse login." });
                                                                                        await sql`INSERT INTO usuarios (usuario, senha, master, trocar) VALUES (${String(body.user).trim()}, ${hash(body.senha)}, ${body.master === true}, true)`;
                                                                                        return json(200, { ok: true });
                                                                                        }

                                                                                        if (acao === "redefinirSenha") {
                                                                                        if (!eu.master) return json(403, { erro: "Apenas o master." });
                                                                                        const alvo = await achar(body.user);
                                                                                        if (!alvo) return json(404, { erro: "Usuario nao encontrado." });
                                                                                        await sql`UPDATE usuarios SET senha = ${hash(body.senha)}, trocar = true WHERE usuario = ${alvo.usuario}`;
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
                                                                                        };
                                                                                        
