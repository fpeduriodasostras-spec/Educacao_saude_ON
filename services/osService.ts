import { supabase } from './supabaseClient';
import { OSCampo } from '../types';
import { hojeLocal } from '../config';

export const osService = {
  // AUDITORIA: antes, um erro no meio da paginação devolvia lista PARCIAL
  // em silêncio → KPIs da Gestão calculados sobre dados incompletos sem
  // ninguém saber. Agora devolve { dados, erro } e o App decide o que exibir.
  async listar(): Promise<{ dados: OSCampo[]; erro: string | null }> {
    // o PostgREST corta em 1000 linhas por requisição — com a planilha
    // importada (~1.8k O.S.) é preciso paginar até vir página incompleta.
    // v71 (caso real da O.S. 913 "sumida"): ordenar SÓ por criado_em é
    // instável — o importão gravou 400+ linhas com o MESMO timestamp, e
    // sem desempate o banco devolve ordem diferente a cada página: linha
    // repetida numa, engolida noutra. O 'id' desempata (único e imutável)
    // e o dedupe por id blinda contra insert concorrente durante a leitura.
    const PAGINA = 1000;
    const todas: OSCampo[] = [];
    const vistos = new Set<number>();
    for (let off = 0; off < 10000; off += PAGINA) {
      const { data, error } = await supabase
        .from('os_campo')
        .select('*')
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
        .range(off, off + PAGINA - 1);
      if (error) {
        console.error('Erro ao listar O.S.:', error.message);
        return { dados: todas, erro: error.message };
      }
      for (const r of (data as OSCampo[]) || []) {
        if (r.id != null && vistos.has(r.id)) continue;
        if (r.id != null) vistos.add(r.id);
        todas.push(r);
      }
      if (!data || data.length < PAGINA) break;
    }
    return { dados: todas, erro: null };
  },

  // v106 — A SESSAO CONFERIDA ANTES, NAO DEPOIS.
  // A conta emergencia1 e da EQUIPE (Leandro + Caleb) e a do Queiroz tambem
  // tem dois aparelhos, por decisao do Renan. O PWA fica horas no bolso com a
  // tela apagada; quando volta, a credencial pode estar vencida. Ate a v105 o
  // app so descobria isso NO MEIO do salvamento — e cada tentativa recusada
  // queimava um numero da sequencia do banco (6 queimados em 21 e 22/09).
  // Agora confere e renova ANTES de comecar. Nunca derruba o fluxo: se nao
  // conseguir renovar, segue e deixa o erro aparecer com a mensagem certa.
  async garanteSessao(): Promise<void> {
    try {
      const { data } = await supabase.auth.getSession();
      const s: any = data?.session;
      if (!s) return;                       // sem sessao: o login cuida disso
      const faltam = (Number(s.expires_at || 0) * 1000) - Date.now();
      if (faltam < 120000) await supabase.auth.refreshSession();   // menos de 2 min
    } catch { /* nao atrapalha o salvamento */ }
  },

  async salvar(os: OSCampo, jaRenovou = false): Promise<{ ok: boolean; erro?: string; os?: OSCampo }> {
    const payload = { ...os };
    delete (payload as any).id;
    delete (payload as any).criado_em;

    if (os.id) {
      let { error } = await supabase.from('os_campo').update(payload).eq('id', os.id);
      // resiliência: banco sem coluna nova ainda ('area'/'geo'/'local') → tira e salva
      if (error && /'(area|geo|local|contrato)'/i.test(error.message)) {
        const p2: any = { ...payload };
        delete p2.area; delete p2.geo; delete p2.local; delete p2.contrato;
        ({ error } = await supabase.from('os_campo').update(p2).eq('id', os.id));
      }
      // v86: devolve a O.S. também na EDIÇÃO — sem isso a tela não tinha o
      // registro atualizado e o painel "mandar pro grupo" só aparecia ao criar
      // (pedido do Renan: quem corrige precisa poder recompartilhar).
      return { ok: !error, erro: error?.message, os: error ? undefined : ({ ...os, ...payload } as OSCampo) };
    }
    // PISO ANTI-COLISÃO COM O PAPEL (conciliação 06/07: a contagem manual
    // já chegou a F-87): sem nº oficial e sem ref de equipe, o app gera o
    // F-nº AQUI com piso 88 — o trigger do banco vira só reserva
    if (!payload.numero && !payload.fict_ref) {
      const f = await this.proximaF();
      if (f) payload.fict_ref = `F-${f}`;
    }

    // insert devolve a linha gravada — o trigger do banco atribui o F-nº
    let { data, error } = await supabase.from('os_campo').insert([payload]).select().single();

    // resiliência a colunas que ainda não existem no banco (SQL pendente):
    // vai tirando a coluna apontada no erro e re-inserindo, em cadeia
    let base: any = { ...payload };

    // sem 'fict_ref' (numeração de equipe) → tira; sai F-nn do trigger
    if (error && /fict_ref/i.test(error.message) && !/duplicate|unique/i.test(error.message)) {
      delete base.fict_ref;
      ({ data, error } = await supabase.from('os_campo').insert([base]).select().single());
    }

    // sem 'tipo' (Emergencial/Corretiva/Preventiva) → tira e re-insere
    if (error && /'tipo'/i.test(error.message)) {
      delete base.tipo;
      ({ data, error } = await supabase.from('os_campo').insert([base]).select().single());
    }

    // sem 'area' → tira e re-insere
    if (error && /'area'/i.test(error.message)) {
      delete base.area;
      ({ data, error } = await supabase.from('os_campo').insert([base]).select().single());
    }

    // sem 'geo' (GEO-COLUNA.sql pendente) → tira e re-insere
    if (error && /'geo'/i.test(error.message)) {
      delete base.geo;
      ({ data, error } = await supabase.from('os_campo').insert([base]).select().single());
    }

    // empate no F-nº (dois salvamentos juntos): recalcula e tenta 1x
    if (error && /duplicate|unique/i.test(error.message) && String(base.fict_ref || '').startsWith('F-')) {
      const f2 = await this.proximaF();
      if (f2) {
        base.fict_ref = `F-${f2}`;
        ({ data, error } = await supabase.from('os_campo').insert([base]).select().single());
      }
    }

    // sem a coluna 'local'/'contrato' (SQL pendente) → tira e insere assim
    // mesmo: a O.S. entra sem o campo em vez de o registro inteiro se perder
    if (error && /'(local|contrato)'/i.test(error.message)) {
      delete base.local; delete base.contrato;
      ({ data, error } = await supabase.from('os_campo').insert([base]).select().single());
    }

    // resiliência: se o banco ainda não tem a coluna 'solicitado',
    // funde o pedido do fiscal dentro do serviço e salva mesmo assim
    if (error && /solicitado/i.test(error.message)) {
      const p2: any = { ...base };
      if (p2.solicitado) {
        p2.servico = `[FISCAL PEDIU] ${p2.solicitado} | [EXECUTADO] ${p2.servico || ''}`.trim();
      }
      delete p2.solicitado;
      delete p2.area;     // banco sem 'solicitado' também não tem 'area'
      delete p2.fict_ref; // nem a numeração de equipe
      delete p2.tipo;     // nem o tipo de atividade
      const r2 = await supabase.from('os_campo').insert([p2]).select().single();
      return { ok: !r2.error, erro: r2.error?.message, os: r2.data as OSCampo };
    }

    // v106: se o banco recusou por CREDENCIAL, renova e tenta mais uma vez.
    // Mesma protecao que o uploadFoto ganhou na v104 — faltava aqui, e era por
    // isso que a foto se recuperava sozinha e a O.S. ainda morria.
    if (error && !jaRenovou && /jwt|unauthorized|not authorized|row-level|invalid token|401|403/i.test(error.message || '')) {
      try {
        const { error: eRenova } = await supabase.auth.refreshSession();
        if (!eRenova) return await osService.salvar(os, true);
      } catch { /* nao deu: cai na mensagem abaixo */ }
    }

    return { ok: !error, erro: error?.message, os: data as OSCampo };
  },

  // EXCLUSÃO = MARCA, nunca apaga (regra Renan 06/07): a linha fica no
  // banco com excluida=true, o número segue ocupado na contagem e o
  // trigger do banco grava quem/quando/o que era no os_campo_log
  async excluir(id: number): Promise<boolean> {
    let { error } = await supabase.from('os_campo')
      .update({ excluida: true, status: 'Cancelada' }).eq('id', id);
    // banco sem a coluna ainda (AUDITORIA-EDICOES.sql pendente) →
    // ao menos cancela; NUNCA mais delete físico pelo app
    if (error && /excluida/i.test(error.message)) {
      ({ error } = await supabase.from('os_campo')
        .update({ status: 'Cancelada' }).eq('id', id));
    }
    return !error;
  },

  // Próximo F-nº GLOBAL calculado pelo app: maior entre F-nn legado
  // (numero_fict), F-refs novas e o PISO 87 (contagem do papel chegou
  // lá em 24/06 — conciliação da planilha da Brendah). Dispensa o
  // setval do banco. null = coluna fict_ref ausente (deixa p/ o trigger).
  async proximaF(): Promise<number | null> {
    try {
      const [a, b] = await Promise.all([
        supabase.from('os_campo').select('numero_fict').not('numero_fict', 'is', null)
          .order('numero_fict', { ascending: false }).limit(1),
        supabase.from('os_campo').select('fict_ref').like('fict_ref', 'F-%'),
      ]);
      if (b.error) return null; // sem coluna fict_ref → trigger resolve
      let m = 87;
      const nf = (a.data?.[0] as any)?.numero_fict;
      if (nf && nf > m) m = nf;
      for (const r of (b.data as { fict_ref: string }[]) || []) {
        const n = parseInt(String(r.fict_ref).slice(2), 10);
        if (!isNaN(n) && n > m) m = n;
      }
      return m + 1;
    } catch { return null; }
  },

  // O nº oficial digitado já existe? (guarda anti-duplicata — caso real
  // 06/07: equipe digitou "79" seguindo a contagem do papel e colidiu
  // com a O.S. 79 oficial de janeiro)
  async numeroExiste(n: number): Promise<OSCampo | null> {
    // order fixo: nas duplicatas legadas (1218/1673), reportar a MESMA linha
    // que buscaPorNumero abriria
    const { data, error } = await supabase.from('os_campo')
      .select('id,numero,unidade,status').eq('numero', n)
      .order('id', { ascending: true }).limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as OSCampo;
  },

  // v110: a O.S. COMPLETA pelo nº oficial — o deep link do fiscal abre em
  // EDIÇÃO quando ela já existe (ponte 3x/dia ou colega), em vez de mandar
  // o colaborador caçar na lupa (pedido do Renan 29/09).
  // not(excluida is true) e não eq false: linha legada com excluida NULL
  // também é viva (eq.false não casa NULL)
  async buscaPorNumero(n: number): Promise<OSCampo | null> {
    const { data, error } = await supabase.from('os_campo')
      .select('*').eq('numero', n).not('excluida', 'is', true)
      .order('id', { ascending: true }).limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as OSCampo;
  },

  // NUMERAÇÃO POR EQUIPE (L01/M01…): calcula o próximo da equipe; o índice
  // único do banco derruba empate de 2 celulares e o salvarEquipe re-tenta.
  // Devolve null se a coluna fict_ref ainda não existe (fallback = F-nn).
  async proximaRefEquipe(prefixo: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('os_campo')
      .select('fict_ref')
      .like('fict_ref', `${prefixo}%`);
    if (error) return /fict_ref/i.test(error.message) ? null : `${prefixo}01`;
    let maior = 0;
    for (const r of (data as { fict_ref: string }[] | null) || []) {
      const n = parseInt((r.fict_ref || '').slice(prefixo.length), 10);
      if (!isNaN(n) && n > maior) maior = n;
    }
    return `${prefixo}${String(maior + 1).padStart(2, '0')}`;
  },

  // Salva O.S. NOVA da equipe com a ref L/M-nº — até 3 tentativas se outro
  // celular pegar o mesmo número no mesmo segundo (erro de chave única).
  async salvarEquipe(os: OSCampo, prefixo: string): Promise<{ ok: boolean; erro?: string; os?: OSCampo }> {
    if (os.id || os.numero) return this.salvar(os); // edição/nº oficial: fluxo normal
    for (let tent = 0; tent < 3; tent++) {
      const ref = await this.proximaRefEquipe(prefixo);
      if (!ref) return this.salvar(os); // banco sem a coluna ainda → F-nn do trigger
      const r = await this.salvar({ ...os, fict_ref: ref });
      if (r.ok || !/duplicate|unique|ux_os_fict_ref/i.test(r.erro || '')) return r;
    }
    return this.salvar(os); // 3 empates seguidos (improvável) → F-nn garante o registro
  },

  // Próximo número da contagem FICTÍCIA (legado do Chat; piso atualizado
  // p/ 88 após a conciliação mostrar o papel em F-87).
  async proximaFict(): Promise<number> {
    const INICIO_FICT = 88;
    const { data, error } = await supabase
      .from('os_campo')
      .select('numero_fict')
      .not('numero_fict', 'is', null)
      .order('numero_fict', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return INICIO_FICT;
    return Math.max((data[0] as any).numero_fict + 1, INICIO_FICT);
  },

  // KIT EMERGENCIAL: baixa automática no estoque — cada item usado vira
  // uma linha de saida_material amarrada à O.S. (origem KIT EMERGENCIAL),
  // exatamente como se o João tivesse lançado. Devolve quantas falharam.
  async baixaKit(itens: { descricao: string; quantidade: number; unidade: string }[], osRef: string, escola: string): Promise<number> {
    if (!itens.length) return 0;
    const hoje = hojeLocal();
    const linhas = itens.map(i => ({
      data: hoje, descricao: i.descricao, quantidade: i.quantidade,
      unidade: i.unidade, os_ref: osRef || null, escola, origem: 'KIT EMERGENCIAL'
    }));
    const { error } = await supabase.from('saida_material').insert(linhas);
    return error ? itens.length : 0;
  },

  // v103: DEVOLVE O MOTIVO. Antes isto engolia o erro num console.error e
  // devolvia null — quem chama só sabia "falhou". Com isso, cota estourada,
  // permissão negada e arquivo grande demais viravam todos a mesma frase
  // "sinal fraco?" na tela do campo, e a gente ficava sem saber o que houve
  // (caso do Caleb, 21 e 22/09: gravações recusadas sem nenhuma pista).
  async uploadFoto(file: File, jaRenovou = false): Promise<{ url: string | null; erro?: string }> {
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `os/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage.from('fotos-os').upload(path, file);
      if (error) throw error;
      const { data } = supabase.storage.from('fotos-os').getPublicUrl(path);
      return { url: data.publicUrl };
    } catch (e: any) {
      const cru = String(e?.message || e?.error || 'falha desconhecida');
      const st = Number(e?.statusCode || e?.status || 0);
      const ehSessao = st === 401 || st === 403
        || /jwt|unauthorized|not authorized|row-level|invalid token/i.test(cru);

      // v104 — DOIS CELULARES NO MESMO LOGIN.
      // A conta emergencia1 é da EQUIPE (Wellington, Leandro e Caleb) e isso
      // é por decisão do Renan: o Caleb é o motor do Leandro, andam juntos.
      // Provado pelo GPS: a O.S. 2471 e a 2474 foram carimbadas no mesmo
      // instante a 12,2 km uma da outra — dois aparelhos ao mesmo tempo.
      //
      // CORREÇÃO v107: eu escrevi aqui que "quando um entra de novo, a
      // credencial do outro deixa de valer". ISSO ESTÁ ERRADO e mandou a
      // investigação para o lado errado. Um login novo cria uma sessão
      // INDEPENDENTE no Supabase e não derruba as outras. Quem derruba é o
      // botão SAIR: signOut() sem argumento usa scope 'global' e revoga a
      // credencial em TODOS os aparelhos da conta. Corrigido em App.tsx.
      // Esta renovação continua valendo como rede de segurança — token vence
      // com o celular no bolso, a tela apaga, a renovação automática falha —
      // mas ela não é mais a explicação principal.
      if (ehSessao && !jaRenovou) {
        try {
          const { error: eRenova } = await supabase.auth.refreshSession();
          if (!eRenova) return await osService.uploadFoto(file, true);
        } catch { /* não deu: cai na mensagem clara abaixo */ }
      }

      // o que o campo precisa DECIDIR é uma coisa só: tentar de novo resolve?
      let erro = cru;
      if (st === 413 || /exceeded|quota|maximum.*size|payload too large/i.test(cru)) {
        erro = 'ESPAÇO DE FOTOS ESGOTADO no servidor — tentar de novo NÃO resolve, avise a gestão.';
      } else if (ehSessao) {
        erro = 'SESSÃO CAIU e não deu pra renovar (outro celular entrou neste mesmo login) — saia do app e entre de novo.';
      } else if (/failed to fetch|network|timeout|abort/i.test(cru)) {
        erro = 'a rede caiu no meio do envio — sinal fraco, pode tentar de novo.';
      }
      console.error('Erro no upload da foto:', cru);
      return { url: null, erro };
    }
  },

  // AUDITORIA: sobe o lote e informa quantas FALHARAM — foto de evidência
  // perdida em silêncio é glosa na medição. Quem chama decide avisar.
  // v99: comprime, sobe de 3 em 3, dá prazo de 60s por foto e reporta
  // progresso — quem está no campo precisa ver que a coisa anda.
  // v103: três mudanças, todas por causa de perda de prova em campo.
  //  1) ORDEM. Antes era `urls.push(...)` de dentro de 3 trabalhadores em
  //     paralelo, então a ordem era a de CHEGADA: "antes" e "depois" chegavam
  //     trocados no grupo. Agora grava por ÍNDICE e compacta no fim.
  //  2) MOTIVO. Devolve `erros` — a tela não precisa mais chutar "sinal fraco?".
  //  3) QUAIS falharam. Devolve `urlPorIndice`, para quem chama reenviar SÓ o
  //     que faltou em vez de subir o lote inteiro de novo (cada reenvio cego
  //     deixava as fotos do lote anterior órfãs no bucket, para sempre).
  async uploadFotos(
    files: File[],
    aoProgredir?: (feitas: number, total: number) => void,
  ): Promise<{ urls: string[]; falhas: number; erros: string[]; urlPorIndice: (string | null)[] }> {
    const urlPorIndice: (string | null)[] = new Array(files.length).fill(null);
    const erros: string[] = [];
    let falhas = 0, feitas = 0;
    let proximo = 0;
    const PARALELAS = 3;   // 3 é o ponto em que o 4G da escola ainda respira

    const trabalhador = async () => {
      while (true) {
        const i = proximo++;                 // incremento é atômico no JS de uma thread
        if (i >= files.length) break;
        const leve = await comprimirFoto(files[i]);
        const r = await comPrazo<{ url: string | null; erro?: string }>(
          osService.uploadFoto(leve), 60000);
        if (r && r.url) {
          urlPorIndice[i] = r.url;
        } else {
          falhas++;
          const motivo = r?.erro || 'passou de 60s e foi cancelada — sinal muito fraco.';
          if (!erros.includes(motivo)) erros.push(motivo);
        }
        feitas++; aoProgredir?.(feitas, files.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALELAS, files.length) }, trabalhador));
    const urls = urlPorIndice.filter((u): u is string => !!u);   // ordem preservada
    return { urls, falhas, erros, urlPorIndice };
  }
};

// =====================================================================
// v99 — POR QUE ISTO EXISTE (caso do Caleb, 14/09/2026): ele adicionou as
// fotos, o botão ficou girando e nada saía. O storage estava perfeito
// (testei: 586 ms por foto). O gargalo era o caminho no app:
//   · a foto subia CRUA, do jeito que o celular tira (2 a 5 MB cada)
//   · o lote subia UMA DE CADA VEZ, em fila
//   · não havia PRAZO: uma foto presa no 4G da escola travava o resto
//   · e a tela não dava sinal nenhum entre "salvando" e o fim
// 12 fotos viravam ~40 MB em série, sem feedback. Não estava quebrado:
// estava lento e parecendo morto — que, para quem está em campo com a
// escola esperando, dá no mesmo.
// =====================================================================

const LADO_MAX = 1600;   // suficiente p/ ler medidor, trinca, azulejo solto
const QUALIDADE = 0.72;  // ~250 KB por foto, contra 2-5 MB do original

// Reduz a foto ANTES de subir. Se qualquer coisa falhar (formato exótico,
// HEIC que o navegador não decodifica, memória), devolve o arquivo original
// — perder qualidade é ruim, perder a foto é inaceitável.
export const comprimirFoto = async (file: File): Promise<File> => {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
    if (escala === 1 && file.size < 900_000) { bmp.close?.(); return file; } // já é leve
    const w = Math.round(bmp.width * escala), h = Math.round(bmp.height * escala);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) { bmp.close?.(); return file; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob: Blob | null = await new Promise(res => cv.toBlob(res, 'image/jpeg', QUALIDADE));
    if (!blob || blob.size >= file.size) return file;  // não piorou? fica o original
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
};

const comPrazo = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]);
