// Service worker do app "Equipe · Gestão de Trabalho".
//
// Regra principal: a página em si (o index.html) SEMPRE tenta vir da rede
// primeiro. Isso é o que evita o problema de alguém ficar travado numa
// versão antiga do app depois que você publica uma atualização — só cai
// pro que está guardado no aparelho se a pessoa estiver sem internet.
// Outros arquivos (ícones, fontes) usam o que já está guardado e atualizam
// por trás, pra abrir rápido sem travar o uso offline.
//
// Você não precisa mexer neste arquivo a cada atualização do app — ele já
// busca a versão nova sozinho. Só troque o número da linha abaixo se um dia
// quiser forçar a limpeza total do cache de todo mundo de uma vez.
const CACHE_NAME = "equipe-cache-v2";

self.addEventListener("install", (event) => {
  // Assume a versão nova assim que ela terminar de instalar, sem esperar
  // todas as abas antigas fecharem.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Navegação (abrir o app, apertar F5, etc.): rede primeiro, cache só de reserva.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copia));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  // Demais arquivos (ícones, manifesto, fontes): usa o que já tem guardado
  // pra ser rápido, e atualiza o cache por trás pra próxima vez.
  event.respondWith(
    caches.match(req).then((emCache) => {
      const buscaNaRede = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copia = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copia));
          }
          return res;
        })
        .catch(() => emCache);
      return emCache || buscaNaRede;
    })
  );
});
