# Migração Neon → Cloudflare D1

## 1. Arquivos para o repositório
- `index.html` → substitui o atual (raiz)
- `functions/api.js` → substitui o atual
- `package.json` → substitui o atual (não precisa mais do pacote do Neon)
- Pode apagar a pasta `netlify/` e o `netlify.toml`

- `wrangler.toml` → novo, na raiz (liga o banco D1 ao projeto automaticamente)

## 2. Deploy
Basta dar push no GitHub. O `wrangler.toml` já configura o binding `DB` → `gestao_equipe`.
Se o deploy reclamar do `wrangler.toml`, apague esse arquivo e faça pelo painel:
Pages → gestao-de-equipe → Settings → Bindings → Add → D1 database, variável `DB`, banco `gestao_equipe`.

## 3. Dados do Neon
No SQL Editor do Neon, rodar e me mandar o resultado (pode ser em arquivo):

```sql
SELECT usuario, senha, master, trocar FROM usuarios;
SELECT conteudo::text FROM dados WHERE id = 1;
```

Eu importo no D1. Se não conseguir acessar, o app sobe com `admin / admin` e começa do zero.
